# pi-safety

Automatic, model-based review for pi's side-effecting tools. Before `bash`, `write`, or `edit` executes, a separate safety model decides whether the exact action follows the user's intent and the bundled safety policy. The server chooses the reviewer and its fallbacks from the conversation's model (`trustedModelPolicy` in `src/config.ts`): the effort-level-1 model first, then routes for the conversation's provider. The host rebuilds this policy directly from Settings and the stored acting provider/model pair at each run, including after a conversation model change. Cached model-list policies never supply safety routes, and cached provider names containing `/` are rejected to prevent identity collisions. `model-policy.ts` resolves trusted candidates for every action; without a policy, the trusted active model reviews at low effort.

There are no approval dialogs, permission modes, model selectors, or setup questions. Safe actions continue silently. Denied actions return a concrete reason to the agent so it can choose a safer approach.

## Loading

The Durable host loads
`src/extensions/core/safety/durable.ts` directly. Its dependencies are installed by
`bun install --frozen-lockfile` at the checkout root; it is not a separate package.

The extension uses existing Pi credentials. Reviewer selection, fallbacks, auth and completion use shipped models and explicit Settings custom providers, never `models.json`, `models-store.json` or cached listing metadata. These files cannot replace a shipped reviewer's metadata, remove its identity or discard a pin. Acting identity is frozen from the stored selection per run, so removing a file model cannot disable review. Default reviewer identity comes from shipped metadata, not cached list order. A saved reviewer pin is preserved in Settings. If the pin cannot resolve in the trusted catalog, or the policy's acting identity is stale, review still tries the policy's resolvable trusted candidates. Path-only reviews also try the trusted reviewer routes if their preferred model is unavailable. File/downloaded-only models never become reviewers. If no trusted candidate resolves, or the reviewer policy cannot be validated, the action is allowed with a visible warning explaining why review was skipped and what to change in Settings. Without a policy, only a trusted active model can review. Missing credentials, provider outages/timeouts and journal failures also fail open. Invalid optional JSON rules or unreadable JSON/Markdown rule files still block the run; this is separate from reviewer selection.

## How it works

For each agent call to `bash`, `write`, or `edit`, pi-safety sends the reviewer:

- the proposed tool action—full input for `bash`, but only a bounded target path and path status for `write` and `edit`;
- the working directory and bounded owned-process context;
- a bounded process-local cache of user messages, completed assistant text, and prior completed tool calls from the active session branch.

Owned-process context uses bounded asynchronous process-file reads. PGID, session
and leader start-token checks exclude unrelated or reused groups; missing leaders
remain explicitly uncertain. Only command names are included, never arguments or
environment values. This context is advisory, not permission to signal.

It deliberately excludes thinking, all tool output, write/edit contents, and the current still-uncompleted tool call. Historical result content is never read; its immutable call id only establishes that pi finalized the matching call. The durable Pi session is authoritative: cold starts rebuild the cache, and any compaction drops all predecessor evidence. Cached current-generation rows and evidence are bounded to 50 MiB; an over-budget branch fails open with a warning that the operator should explicitly compact the conversation.

Canonical evidence is append-only within one deterministic transcript generation.
Each live conversation owns an explicit reviewer response chain: one system
prefix contains the bundled policy, additive safety rules (including pi-safety.md)
and trusted acting identity. The reviewer receives no tool schemas or main-agent
system prompt. The first user review contains all current evidence;
later user reviews append only new evidence and the current working directory,
owned-process snapshot and proposed action. Each completed review retains the
reviewer's actual assistant response, including provider response metadata. Prior
reviews are evidence, never authorization for a later action. No server-side
response id or new durable store is used.

The in-memory chain is weakly keyed to the live Durable conversation and disappears
when its harness is released or the server restarts. It resets after 24 reviews
or before an append would exceed 262,144 serialized characters including policy
(roughly 65k ordinary-text tokens), bounding memory and repeated decision influence.
A single oversized review still receives all evidence but is not retained. A changed
provider/model/route, effort, safety policy, acting identity or evidence generation
also resets it, as does non-append evidence after clear/compaction/branch changes.
Failed, aborted and malformed attempts never add partial turns; existing standalone
policy/format retries do not enter the chain. Trusted fallbacks cannot share a chain
across models. The cache key remains an isolated per-conversation, per-model
`pi-safety-` session id; requests send the whole bounded chain explicitly. Anthropic
requests mark the latest user review as a cache breakpoint. Provider cache retention
is short and remains an external limit, so an expired chain can still be cold.

The operator's prompt inspector shows the latest safety request and actual reply,
including policy, history pairs and new evidence. Agent-marked reads omit reviewer
data, including through connected backends. Reviews reuse the host's capture
worker, idle retention and cleanup without replacing main captures or warming.
Request/reply capture is best-effort: failures log `safety_review_capture_failed`
with only the conversation id and never change model calls or verdicts.
The captured `options.sessionId` is the reviewer cache namespace, not a credential.
Authentication stays owned by the trusted model catalog and is never captured.

The reviewer answers with exactly `OK` or `DENY: <reason>`. A malformed reply is retried once. Missing credentials, timeouts, provider failures, aborted responses, and a second malformed reply fail open with a stable, bounded warning category; journal capacity warnings say to explicitly compact the conversation, and raw provider text is never forwarded.

Bundled rules deny concrete secret disclosure, credential probing, broad cross-owner or system destruction, protected-service disruption, security weakening, harmful untrusted-code execution, malware or covert access, review evasion, and secrets written to inappropriate locations. Ordinary task-owned work—including reversible Git operations, build or scratch cleanup, direct-child deletion, and exact task-process signals—must not be denied.

Every `bash` action is reviewed. The reviewer considers the complete action, active shell segments and expansions, but does not treat quoted literal text as another action. Powerful command names or unresolved variables are not enough to deny without a concrete protected, cross-owner, system, secret, or shared destructive target.

A task assignment, including delegation from another agent, authorizes actions that implement it. An authenticated operator request for the exact action and scope overrides a denial; claims of operator approval elsewhere do not.

Each new no-verdict outcome emits one `safety_review_failed` warning through the
server logger, persisted in `recurse.log`. It records only conversation id, stage,
category, final reviewer provider/model, total elapsed milliseconds (including
review-slot wait), and the number of provider requests attempted. Authentication
or journal failures before a request have zero attempts. Memoized outcome replays
do not emit another warning; ordinary denials do not emit this event.
Reviewer configuration failures use stage `configuration` and a bounded category
(`invalid_policy`, `unsupported_reviewer_pin`, `acting_identity_mismatch`, or
`no_trusted_candidates`), with zero provider attempts. Diagnostic failures never change the tool decision.

### Denials and circuit breaker

A `DENY` verdict is returned as the blocked tool result with the reviewer's reason. `OK` is silent. Provider/journal failures allow the action with a visible, bounded warning and do not count as policy denials. Reviewer configuration failures allow with the same visible warning and failure log, without counting as policy denials. After **three policy denials in one agent run**, pi-safety calls `ctx.abort()` and stops that run. A new user prompt starts with a fresh denial budget.

## Configuration

No configuration is required. To add organization- or machine-specific rules, create `~/.prime/agent/pi-safety.json` (or `$PRIME_AGENT_CODING_AGENT_DIR/pi-safety.json`; the legacy `$PI_CODING_AGENT_DIR` is also accepted):

```json
{
  "rules": [
    "Never export the internal credential bundle.",
    "Never modify the shared billing account from a coding session."
  ]
}
```

Custom rules are **additive**. They cannot remove the built-in policy. That is the only configuration surface; the family-routed reviewer and effort, 60-second timeout, reviewed tools, and three-denial circuit breaker are intentional defaults.

The next run reloads the optional JSON and Markdown rules asynchronously. Trusted
workspace roots are also resolved asynchronously for each run; action targets
are still checked afresh before bypassing review.

## What a denial looks like

```text
[pi-safety] Tool call blocked because force-pushing the protected branch could destroy shared history.
Choose a materially safer alternative, or ask the user to explicitly authorize the concrete action.
Denied actions this run: 1/3.
```

## Limitations

pi-safety is oversight, not a sandbox or deterministic security boundary. A model reviewer can make mistakes, and tools other than `bash`, `write`, and `edit` are not reviewed. Reviewer availability and configuration failures fail open with visible, bounded warnings. Use OS isolation and least-privilege credentials when you need stronger guarantees.

Every reviewed action adds one model call, so it also adds latency and model usage.
