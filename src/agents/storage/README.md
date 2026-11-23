# Agent and conversation storage

Owns persisted agent metadata and pending intents, and the conversation record
projection built from them. Both the runtime and the supervisor use this layer;
storage does not import either one or the instance that wires them together.

**Source files:** [index.ts](index.ts) exposes the storage contracts;
[agent_store.ts](agent_store.ts) admits bounded mutations and dispatches database
work to [agent_store.worker.ts](agent_store.worker.ts);
[conversation_store.ts](conversation_store.ts) owns the title and mute file locks
and publishes the in-memory projection. [Config actions](../runtime/config_actions.ts)
combine the metadata locks with the live node lock;
[service_bindings.ts](service_bindings.ts) stores service ownership and external
keys in separate files and checks targets through the live projection. Bindings
a create writes carry that attempt's token, so its rollback removes only its
own; a create reserves a row with no existing storage and discards only that,
but a write still running after a bounded wait keeps the row's files;
[conversation_model_choices.ts](conversation_model_choices.ts) freezes existing
model choices in a recorded startup pass.

Legacy pinned records read as taken over unless the record already has a
Take over value. This preserves the operator's hold without a startup migration.

## Rules for changes

- Admit a durable mutation before publishing its projection. Keep database
  waits and fsyncs off the send path.
- Keep the SQLite Worker next to its client so the literal Worker URL resolves.
  The Worker imports only the client's protocol types.
- Notify the row listener synchronously after publication. Tree composition,
  node lifecycles and HTTP stay out of storage.
- Subtree and descendant reads share the child walk. Finding a root follows
  only its live ancestors rather than scanning unrelated rows.
