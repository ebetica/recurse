# Agent guide

Every agent's context includes this contract. Read task-specific guidance as
needed; don't copy it here.

## Roles and the agent tree

Agents form a tree. The operator and agents can message any agent.

- When the operator asks for research, start a taken-over subagent
  (`--taken-over`) so they can work with it directly.
- Do only the task you were given. Implementers work in their own managed
  worktrees and open PRs; reviewers and verifiers edit nothing.
- In your final message, give each outcome first, then key evidence. Final
  messages go to your parent automatically; send messages manually only for
  urgent questions. Ask the operator for decisions only they can make, directly
  or via your parent. Finish and reap your children.
- Merge, promote or deploy only when the operator asks you to.

## Non-negotiable constraints

- **Build only assigned work.** Later exact instructions override older generic ones.
- **Never edit Recurse's `README.md` without explicit authorization.**
- Never expose secrets, credentials, tokens, private prompts, or another user's
  data. Only Settings login flows own long-lived credentials (kept in Pi's
  Recurse-owned agent directory).
- Never weaken authentication, owner-scoped authorization, safety review,
  process cleanup, or runs decoupled from HTTP.
- Side-effecting tools are safety-reviewed by default; never bypass a denial.
  Only authenticated operators may turn review off for a conversation.
- Pi is the only coding backend, including Pi Durable. Add model capabilities
  to Pi or a Pi extension, not a parallel runner. Claude uses Anthropic; the
  ChatGPT subscription and OpenAI platform keys are separate routes, never
  fallbacks for each other.
- Put disposable files in `$RECURSE_AGENT_TMPDIR`/`$TMPDIR`, not the repo or a
  shared path. Shared directories are read-only; enter a managed worktree
  before any edit or commit.
- Use the tool paths and `--help` in the generated Recurse tools section; never
  guess flags.

## Product and architecture principles

- **Build the simplest thing that works.** Give each folder module one job and a
  thin `index.ts`; imports between files and modules stay acyclic (exceptions need
  operator approval). Keep tools small. Extend an existing lifecycle CLI instead
  of duplicating it. Simplify large files; do not mechanically split them.
  Report architecture sweep findings to the Coordinator; do not trim to fit.
- Pi owns sessions, turns, steering, and aborting; Recurse owns the tree and
  inter-agent messages. Never recheck, retry, or repair successful Pi calls
  without a named, reproducible bug.
- Everything sent to a model must be inspectable. Agent roles live in the
  target repo's AGENTS.md, not in flags. Before changing how prompts are built
  or captured, read the headers of `src/agents/durable/prompt_resources.ts`,
  `prompt_sections.ts`, `request_capture.ts` and `src/agents/runtime/prompts.ts`.
- Runs are durable background jobs. HTTP only enqueues and reads; refreshes,
  disconnects, and restarts must not lose work.
- Keep maintenance and scans proportional to live entities, not history, and
  read history in bounded pages. Prune finished shells, runs, agents, and
  worktrees. Remove directory trees with `retire` from `src/utils/trash.ts`
  (same-filesystem rename), never by recursive deletion inline, under a lock,
  or in a request. Run and record migrations once, never per turn. Never block
  the event loop with synchronous subprocesses, blocking locks, or unbounded
  scans.
- Show live state, tools, partial output, and actionable failures; never hide
  asynchronous work. Log how long a wait took and who held it. Loading the
  conversation the user has open is the critical path; best-effort warming and
  caching must never delay it.
- Key uploads, published files, tool payloads, Artifacts, processes, and
  worktree holders to conversations for quotas and cleanup. Ownership is
  bookkeeping, not permission or cwd boundaries: one operator owns the instance;
  never gate inter-agent reads or messages on tree relationships.
- Name observable behaviour, not mechanisms, in settings, APIs, flags, keys,
  and UI. Rename public names that need explanation. Tell users what something
  is; avoid unexplained jargon and metaphors.
- UI: before any web UI change, read
  [the UI design rules](.agents/skills/ui-design/SKILL.md); its Recurse rules
  bind.

## Repository map

Run `bun tools/code_map.ts <folder>` to find the owning code before changing it.
Read its README, module header and focused tests. Headers, implementation and
tests are authoritative.

## PR rules

1. **Scope.** One coherent feature or fix per PR, the smallest working diff,
   written in plain, literal statements. Preserve all constraints. Only an
   agent the operator asks to merge does so; squash each PR on its own, and
   don't stack PRs.
2. **Evidence.** Before starting implementation or review, read
   [the evidence tiers](docs/agents/develop.md#evidence-and-review), classify the work
   and state the tier in the PR. Get feedback if the final diff changes it.
   Exact operator directives override blast radius, uncertainty, and expected size.
3. **No PR Actions.** GitHub Actions run only after pushes to `main`; never
   request, rerun, or spend them on PR validation. CI is no substitute for
   smoke gates.
4. **Documentation.** AGENTS.md holds the rules; [develop.md](docs/agents/develop.md)
   covers contributions and tests. Module headers and tests own behaviour,
   configuration, invariants and security. Update a part's README with its code.
   Tell a new reader why the part is arranged this way today. Link to code
   instead of repeating code, headers, tests or --help. For layout, run
   `bun tools/code_map.ts <folder>`. Guides in docs/ link to code. CLI changes
   update injected JSDoc/--help.
5. **Protected branches.** Never rewrite published PR branches. Branch from
   merged `main`, never from another PR; an operator-named integration branch's
   merged tip is the base and target of its workstream until promotion is
   approved. Give commands, observed results, and required review verdicts at
   the exact head SHA. Fix red tests, or prove with a commit that a failure is
   unrelated and pre-existing.
6. **Continuity.** PR descriptions, commits, headers, and tests must make sense
   without conversational context.

## Development and tests

Before changing code or tests, read [the validation and test-writing
workflow](docs/agents/develop.md#validation). Prettier, TypeScript, and Oxlint
are mandatory. Never commit `web/dist`.

Use targeted evidence by default; reserve the full suite for an exact operator
request or large/high-risk work. Never run tests/check.sh stages concurrently.
Tests prove behaviour on real paths, not mocks or invented pure-function inputs.
Changes to sending, running or showing a reply need a test that sends a message
through the fake provider. Prefer fewer tests and extend integration tests.
Never add a `test-check-allow` comment or allowance entry unless an independent
test review passes the exact head (docs/agents/test-review.md); otherwise delete the
test or prove it through an integration or browser test. Fix flakes by waiting
for conditions, not loosening tests.
