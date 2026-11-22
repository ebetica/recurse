# Agent and conversation storage

Owns persisted agent metadata and pending intents, and the conversation record
projection built from them. Both the runtime and the supervisor use this layer;
storage does not import either one or the instance that wires them together.

**Source files:** [index.ts](index.ts) exposes the storage contracts;
[agent_store.ts](agent_store.ts) admits bounded mutations and dispatches database
work to [agent_store.worker.ts](agent_store.worker.ts);
[conversation_store.ts](conversation_store.ts) serializes metadata changes and
publishes the in-memory projection;
[service_bindings.ts](service_bindings.ts) stores service ownership and external
keys in separate files and checks targets through the live projection;
[conversation_model_choices.ts](conversation_model_choices.ts) freezes existing
model choices in a recorded startup pass.

## Rules for changes

- Admit a durable mutation before publishing its projection. Keep database
  waits and fsyncs off the send path.
- Keep the SQLite Worker next to its client so the literal Worker URL resolves.
  The Worker imports only the client's protocol types.
- Keep tree coordination, node lifecycles and HTTP out of this module.
