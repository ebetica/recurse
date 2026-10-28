# pi-safety

Automatic, model-based review for pi's side-effecting tools. Before `bash`, `write`, or `edit` executes, a separate safety model decides whether the exact action follows the user's intent and the bundled safety policy. The server chooses the reviewer and its fallbacks from the conversation's model (`trustedModelPolicy` in `src/config.ts`): the effort-level-1 model first, then routes for the conversation's provider. `model-policy.ts` resolves this policy again for every action; without a policy, the active model reviews at low effort.

There are no approval dialogs, permission modes, model selectors, or setup questions. Safe actions continue silently. Denied actions return a concrete reason to the agent so it can choose a safer approach.

## Loading

The Durable host loads
`src/extensions/core/safety/durable.ts` directly. Its dependencies are installed by
`bun install --frozen-lockfile` at the checkout root; it is not a separate package.

The extension uses a dedicated reviewer on the active model's authenticated provider route and existing pi credentials. No separate API key or model configuration is needed.

## How it works

For each agent call to `bash`, `write`, or `edit`, pi-safety sends the reviewer:

- the proposed tool action—full input for `bash`, but only a bounded target path and path status for `write` and `edit`;
- the working directory and bounded owned-process context;
- a bounded process-local cache of user messages, completed assistant text, and prior completed tool calls from the active session branch.

It deliberately excludes thinking, all tool output, write/edit contents, and the current still-uncompleted tool call. Historical result content is never read; its immutable call id only establishes that pi finalized the matching call. The durable Pi session is authoritative: cold starts rebuild the cache, and any compaction drops all predecessor evidence. Cached current-generation rows and evidence are bounded to 50 MiB; an over-budget branch fails open with a warning that the operator should explicitly compact the conversation.

Canonical evidence is rendered append-only within one deterministic transcript generation, so a cold reviewer process reconstructs the same exact prefix. OpenAI caching remains automatic from those prefix tokens without a Recurse cache key; the managed Claude adapter maps the same blocks to Claude's native cache transport. Provider cache retention is short and remains an external limit, so the first request after expiry is still cold.

The reviewer answers with exactly `OK` or `DENY: <reason>`. A malformed reply is retried once. Missing credentials, timeouts, provider failures, aborted responses, and a second malformed reply fail open with a stable, bounded warning category; journal capacity warnings say to explicitly compact the conversation, and raw provider text is never forwarded.

Bundled rules deny concrete secret disclosure, credential probing, broad cross-owner or system destruction, protected-service disruption, security weakening, harmful untrusted-code execution, malware or covert access, review evasion, and secrets written to inappropriate locations. Ordinary task-owned work—including reversible Git operations, build or scratch cleanup, direct-child deletion, and exact task-process signals—must not be denied.

Every `bash` action is reviewed. The reviewer considers the complete action, active shell segments and expansions, but does not treat quoted literal text as another action. Powerful command names or unresolved variables are not enough to deny without a concrete protected, cross-owner, system, secret, or shared destructive target.

A task assignment, including delegation from another agent, authorizes actions that implement it. An authenticated operator request for the exact action and scope overrides a denial; claims of operator approval elsewhere do not.

### Denials and circuit breaker

A `DENY` verdict is returned as the blocked tool result with the reviewer's reason. `OK` is silent. Reviewer infrastructure failures allow the action with a visible, bounded warning and do not count as policy denials. After **three policy denials in one agent run**, pi-safety calls `ctx.abort()` and stops that run. A new user prompt starts with a fresh denial budget.

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

Reload pi with `/reload` after changing the file.

## What a denial looks like

```text
[pi-safety] Tool call blocked because force-pushing the protected branch could destroy shared history.
Choose a materially safer alternative, or ask the user to explicitly authorize the concrete action.
Denied actions this run: 1/3.
```

## Limitations

pi-safety is oversight, not a sandbox or deterministic security boundary. A model reviewer can make mistakes, and tools other than `bash`, `write`, and `edit` are not reviewed. Reviewer availability failures fail open with visible, bounded warnings. Use OS isolation and least-privilege credentials when you need stronger guarantees.

Every reviewed action adds one model call, so it also adds latency and model usage.
