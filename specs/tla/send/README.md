# Operator sends during a turn

## Source files

- [OperatorSend.tla](OperatorSend.tla), [configuration](OperatorSend.cfg): bounded
  saved-agent/API admission, model-context placement and recovery.
- [Runner](../check.sh): `bash specs/tla/check.sh send` runs the design and seven
  named failing controls; each case has a 110-second deadline.

## Properties and correspondence

Delivery means **one committed input entry in the model's conversation context**,
not one provider HTTP request. Subsequent requests repeat that context, provider
attempts may retry, and interrupted requests may never produce an answer. This
model does not prove exactly-once receipt by an external provider.

| Boundary                      | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Save`, `Attempt`             | [Composer](../../../web/composer.ts) persists before clearing input; [outbox](../../../web/composer/outbox.ts) keeps stable client keys, locks per recipient and attempts its oldest saved entry first. Failed entries stay visible and block later entries.                                                                                                                                                                                             |
| `Admit`, `Reject`, `Respond`  | [HTTP admission](../../../src/web/deliver_message.ts) validates and returns a committed acknowledgement; [delivery](../../../src/agents/supervisor/delivery.ts) maps the key to `op:operator::<id>`; [send](../../../src/agents/durable/host/send.ts) serializes submission. Pi Durable `admitSubmission` atomically checks the persistent request ledger and inserts input. The HTTP `steer` response is advisory, never the busy/idle admission fence. |
| `CutStream`, `Boundary`       | The pinned Pi interrupt patch keeps operator input as a durable steer, cutting only an active provider stream, not tool tasks. Pi `applyBoundary` places selected inputs in inbox order. [Open](../../../src/agents/durable/host/open.ts) selects all steers while running, one at idle.                                                                                                                                                                 |
| `Complete`, `Stop`, `Promote` | [Host Stop](../../../src/agents/durable/host/host.ts) aborts the run task, not the conversation/inbox; [follow](../../../src/agents/durable/follow.ts) promotes the oldest queued input at idle. An idle submission joins behind the existing inbox.                                                                                                                                                                                                     |
| `Reload`, `Retry`, `Restart`  | Composer restores saved keys after reload/reconnect; ambiguous responses retry the same key. Completed server commits survive restart; open/resume and follow recover queued work. Restart collapses interrupted-run settlement and recovery into an idle boundary.                                                                                                                                                                                      |

- **SingleDelivery:** at most one context placement per logical message, including
  a response lost after commit, reload/resend and server restart.
- **MessageAccounted:** every accepted message is queued or already placed;
  Stop, stream interruption and restart cannot silently discard queued inputs.
- **AdmissionOrder:** placements follow server admission order among these
  operator inputs. This is not a global ordering claim across follow-ups, notes,
  other clients or conversations.
- **AcceptedEventuallyDelivered:** TLC checks temporal delivery of each accepted
  message. Weak fairness covers retry/admission/response, idle promotion and turn
  completion; finitely many reloads, failures and stops cannot postpone it forever.
  No promise that an unavailable provider finishes tools or a turn is made.
- **RetryKeepsRun:** neither a normal composer retry nor a replayed explicit
  API interrupt aborts the current/replacement run. Serialized admission checks
  the persistent request ledger before stopping; only a new input can interrupt.

Permanent pre-admission refusal leaves a visible failed saved entry, restored by
reload. It is not acceptance and does not satisfy delivery. Accepted inputs have
no cancellation action in this model: explicit remove/edit, conversation deletion,
clear/archive generations and intentional withdrawal are excluded.

## Bounds and assumptions

Two ordered sends to one unchanged conversation/owner, initially running;
each independently uses normal composer or explicit API interrupt semantics.
One ambiguous retry per message, one reload, one server restart and one Stop. A boundary drains all operator steers; an idle promotion takes one. The
stream/tools states abstract provider interruption versus boundary steering;
tool execution, reply text and actual provider requests are not simulated.

Persistence before clearing the composer, stable identity, atomic Pi ledger/inbox
commits and completed-write survival are assumptions, not a SQLite refinement.
Network failure is finite; processing and turn completion are fair. Filesystem
failure, browser storage loss, concurrent tabs, changing recipient/identity,
attachment validation, draft creation and boot-time unsaved jobs are excluded.
Failed oldest outbox entries can intentionally block later **unaccepted** sends;
there is no unconditional liveness claim for every composer snapshot.

## Controls

Each control must exit 12 naming its property, not time out or fail parsing.
All except `send-interrupt-retry` are synthetic guard removals; that control
restores the historical stop-before-deduplication ordering.

| Case                   | Expected property  | Change                                                                                                                          |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `send-reload-id`       | `SingleDelivery`   | Restore an in-flight saved entry with a new client key.                                                                         |
| `send-restart-ledger`  | `SingleDelivery`   | Lose server deduplication while retaining accepted context/inbox.                                                               |
| `send-stale-steer`     | `MessageAccounted` | Trust the HTTP busy snapshot after that turn ends; orphan its accepted steer.                                                   |
| `send-stop-drop`       | `MessageAccounted` | Clear queued input when aborting the run.                                                                                       |
| `send-restart-drop`    | `MessageAccounted` | Lose committed queued input during restart.                                                                                     |
| `send-reverse`         | `AdmissionOrder`   | Promote the newest queued operator input first.                                                                                 |
| `send-interrupt-retry` | `RetryKeepsRun`    | Replay an explicit API `interrupt: true` request after acceptance; stop the current run before looking up the existing request. |

The last control restores HTTP's former stop-before-send ordering: a lost
acknowledgement followed by retry aborted the replacement/newer run even though
the input was deduplicated. The design now includes explicit interrupts:
`createMessageSender` passes intent into serialized `send()`, which checks Pi's
persistent request ledger before stopping. The admission's `onInterrupt` callback
reports whether it actually stopped a run, false on replay. No new in-memory
ledger or separately persisted run identity is needed for an already-admitted
request; Pi's existing committed submission fences the side effect across restart.
The real API regression discards an accepted response, holds the replacement
provider request, retries the same key and checks run identity, one input and
completed replacement output.

## Real-path evidence and rules for changes

No timer tests are replaced: the focused tests exercise actual Pi Durable,
SQLite, fake-provider requests, interruption and restart, not only abstract
protocol state. Keep [durable delivery](../../../tests/backend/durable_deliver.test.ts),
[Pi interruption](../../../tests/backend/pi_interrupt_patch.test.ts),
[API messages](../../../tests/backend/api_v1_messages.test.ts) and
[client key generation](../../../tests/web/composer-send.test.ts) coverage.
Browser rendering, failure visibility and storage APIs remain real-path concerns.

Update this correspondence and controls when the persistence, key, serialized
admission, busy/idle boundary, Stop or promotion rules change. Inspect the pinned
Pi inbox/submission implementation on dependency upgrades; this is a protocol
model, not automated implementation refinement.
