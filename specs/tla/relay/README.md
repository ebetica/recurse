# Remote relay protocol

[RemoteRelay.tla](RemoteRelay.tla) and [its configuration](RemoteRelay.cfg)
check a bounded protocol, not full implementation refinement. The bulk
`tests/check.sh tla` stage runs the positive model, its temporal property and
all six negative controls. Run a case independently with
`bash specs/tla/check.sh relay` or one of the control names below.

## Properties

- **SingleDelivery:** one receiver admission per logical submission, including
  a lost acknowledgement and retry. Its `client_message_id` stays stable and
  the receiver checks its persistent request ledger before admitting input.
  The scope is one unchanged receiver conversation and authenticated sender
  identity, not a global deduplication key across different senders or keys.
- **NoPrematureLoss:** startup cannot terminalize a send before its retry budget
  ends. Intentional deadline expiry and retirement of a queued credential route
  are distinguished from this premature failure.
- **PauseOnlyIdle:** a sleep answer is issued only when the remote is idle and
  no eligible queued return message takes precedence. This checks the decision,
  not that a paused remote remains idle forever.
- **NoPollingWake:** a sleep answer from a learned, working check-in service
  does not start the sleeping web server. Explicit sends/reads, authenticated
  one-off callback polls and background health probes are not this property.
- **NoAutomaticWhileRevoked:** automatic polls, callbacks and health probes
  cannot issue after rejection is recorded. Ordinary sends are gated too.
  Requests already in flight may finish.
- **RevocationOwnership:** only a successful explicit check/read issued under
  the latest recorded rejection may clear revocation. Every 401 advances this
  ownership, even when already revoked. The comparison occurs at the serialized
  credential-save commit, not merely when HTTP succeeds. Signing in retires the
  old record and its outstanding completion.
- **DeliveryAfterWake:** submitted, retained work eventually reaches the receiver
  **if both processes eventually remain awake and authorized**, that message's
  deadline does not expire and its queued credential route is not retired. Weak fairness is
  assumed for direct retry, ordinary polling, wake observation, receiver
  acceptance and acknowledgement. Wake/startup itself is an environmental
  assumption, not a promise that an unavailable host eventually starts.

The temporal property is checked by TLC, not inferred from the safety checks.
It deliberately makes no unconditional eventual-delivery claim.

## Source correspondence

| Model boundary                                | Production boundary                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Submit`, `Retry`, `Ack`                      | [`relay.ts`](../../../src/web/relay.ts) owns background sends and stable wire ids; [`relay_inbox.ts`](../../../src/web/relay_inbox.ts) claims/reoffers return messages and accepts results.                                                                                                                                                                     |
| Retained return work across stop/start        | [`relay_queue.ts`](../../../src/web/relay_queue.ts) serializes atomic queue writes; the model retains completed writes, not uncommitted ones.                                                                                                                                                                                                                   |
| `Direct`, startup refusal                     | The retry loop in `relay.ts` and the readiness check before conversation lookup in [`deliver_message.ts`](../../../src/web/deliver_message.ts).                                                                                                                                                                                                                 |
| `Poll`, `CheckWake`                           | Inbox sleep/claim ordering and [`ConnectedBackends.poll`, `pollWait`, `wake`](../../../src/backends/connected.ts), including the persisted check-in URL.                                                                                                                                                                                                        |
| Abstract idle input                           | The production idle predicate includes active agents, pending work, background shells, sends and recent home activity. These sources are abstracted together to `idle`, rather than recomputing each subsystem's busy state.                                                                                                                                    |
| `AutoProbe`                                   | `ConnectedBackends.refreshStale` excludes revoked and observed-asleep connections. An unobserved sleeping web server may still be started by a health probe.                                                                                                                                                                                                    |
| `Accept`                                      | [`delivery.ts`](../../../src/agents/supervisor/delivery.ts) maps `client_message_id` into the origin/sender-scoped request id passed through [`host/send.ts`](../../../src/agents/durable/host/send.ts) to Pi Durable's `conversation.submit`. The atomic persistent check-and-insert is the receiver abstraction, not a proof of Pi's database implementation. |
| `Revoke`, `ExplicitStart`, `Resume`, `SignIn` | Connected-backend automatic-request gates, explicit probe/transcript requests, per-record rejection tokens and serialized credential writes. A retired record cannot clear the replacement's flag.                                                                                                                                                              |

## Bounds and exclusions

Two peers, one logical message in each direction, one lost response/expired
claim per message, one stop/start cycle per peer, two observed rejections, one
re-add and one outstanding explicit-operation slot. Explicit operations may
repeat sequentially. The second rejection explores a newer 401 overtaking an
already-revoked request's completion.

Routes have already been learned and are unambiguous, current and keyed.
Queue quotas, migrations, malformed routes and actual credential invalidation
may intentionally discard work; they are not retention guarantees. Re-add may
retire an outstanding return route, recorded in `expired` alongside direct-send
deadline expiry. No unfinished outbound send crosses a home restart or
credential replacement. Receiver deletion/clear, changing sender identity,
archive generations, failed I/O and crashes during credential/queue writes are
outside this model. Credential writes must complete before a home restart.

The receiver ledger and completed return writes survive the modeled restart.
Atomic receiver admission and durable storage semantics are assumed at that
boundary. Lost responses do not roll back admission. Real deadlines and claim
leases are abstract transitions, not simulated clocks; bounded retries and
weak fairness exclude arbitrary perpetual transport failure.

The non-waking poll property requires a persisted, valid check-in URL whose
service answers sleep. Missing URLs, service errors and the deliberate web
fallback can wake an instance and are not covered by that property. Callback
polls deliberately permit a wake, but never bypass revocation.

## Negative controls and history

Each case must fail with TLC exit 12 at the named invariant; another error is
not a successful control. These are small protocol counterfactuals, not whole
historical source reverts.

| Case            | Expected invariant        | Provenance                                                                                                                                                                                |
| --------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay-id`      | `SingleDelivery`          | Synthetic: assign a new wire id on retry. Inspection rejected #3029 (`04b7fff6e`) as an id-history witness: it changes readiness/version ordering, not id propagation.                    |
| `relay-startup` | `NoPrematureLoss`         | Historical failure pattern from #3148 (`3f99b0845`): startup lookup could return terminal 404 before the conversation index was ready. The model collapses recheck plus terminal refusal. |
| `relay-idle`    | `PauseOnlyIdle`           | Synthetic: bypass the inbox idle predicate. Inspection rejected #2994 (`0b7dfb43e`) as this witness: its poll backoff/probe exclusion is a different boundary.                            |
| `relay-wake`    | `NoPollingWake`           | Historical pattern from #3145 (`6f4164387`): missing persisted check-in/use-before-web ordering could start a sleeping web server.                                                        |
| `relay-revoked` | `NoAutomaticWhileRevoked` | Historical pattern from #3000 (`8e45c28b0`): automatic requests lacked the persisted rejected-key gate. The control removes the poll/probe gates, not authentication.                     |
| `relay-stale`   | `RevocationOwnership`     | Missing ownership check in base `f63aca2fd9c9448058850bc5400c60cf54460034`: an old successful explicit request could clear a newer 401.                                                   |

Real-path coverage remains in
[`remote_send.test.ts`](../../../tests/backend/remote_send.test.ts) and
[`remote_idle.test.ts`](../../../tests/backend/remote_idle.test.ts): actual HTTP,
CLI processes, queue files, Pi Durable and the fake provider. It retains service,
agent and callback authorization; actual key revocation and callback removal;
colliding, third-hop and multi-home routes; qualified sends, reads and paging;
unconfirmed outcomes, oversized and archived reads; telemetry, probe avoidance,
compatibility ordering, passive-request idleness and check-in error fallback.
Queue migration, quotas and secret redaction also remain real-path assertions.

The tests shorten injected poll/idle intervals, fixture check-in intervals and
the delivery-confirmation deadline, observing conditions instead of fixed sleeps.
A real home claims a request, advances the claim clock and authenticates another
poll that must reoffer the same request id, then never reports a result. The
clock is restored before the real expiry independently returns unconfirmed to
the CLI and outcome reader. The production deadline stays 90 seconds. Malformed delivery responses separately exercise uncertain admission. The artificial 31-second readiness delay is replaced by
`NoPrematureLoss`; the real lost-ack retry and telemetry assertions remain.
The stale-success regression retains its held real response. The independent
[`cold_start_delivery.test.ts`](../../../tests/backend/cold_start_delivery.test.ts)
still exercises real startup readiness. Neither the model nor these tests
replace browser geometry, drafts, compatibility UI or other security boundaries.
