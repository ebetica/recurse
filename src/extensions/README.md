# Extensions

Extensions add tools and request changes to Pi Durable. The Durable host imports
them from source ([src/agents/durable/host/runtime.ts](../agents/durable/host/runtime.ts));
they have no package installs of their own and use the root `node_modules/`.
Tests mirror this layout in `tests/extensions/`, and `tests/check.sh ts` runs them.

`core/` holds what every conversation needs; `extra/` holds the rest.

| Directory                                                 | What it does                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [core/safety/](core/safety/README.md)                     | Reviews every side-effecting tool call with a reviewer model before it runs                                        |
| [core/shells/](core/shells/README.md)                     | The `bash` and `wait` tools: detached shells, background commands and monitors                                     |
| [core/context/](core/context/context.ts)                  | Context limits, compaction ([durable-compaction.ts](core/context/durable-compaction.ts)) and bounded search output |
| [core/environment/](core/environment/managed_tools.ts)    | Persistent cwd/env, operator file publication and deferred Artifacts (`env`, `chdir`, `publish`, `artifact`)       |
| [extra/fff/](extra/fff/fff.ts)                            | Fast file search (`grep`, `find`) in one shared child process                                                      |
| [extra/mcp/](extra/mcp/mcp.ts)                            | MCP servers configured in Settings; agents call them from code-mode scripts                                        |
| [extra/rtk/](extra/rtk/rtk.ts)                            | Rewrites an approved shell command through RTK to shorten its output                                               |
| [extra/model-clock/](extra/model-clock/model-clock.ts)    | Adds the current time to model-bound copies of messages                                                            |
| [extra/codex/](extra/codex/codex.ts)                      | Request clean-up and server compaction ([compaction.ts](extra/codex/compaction.ts)) for ChatGPT (Codex) models     |
| [extra/cache-warm/](extra/cache-warm/README.md)           | Keeps the latest main-model prompt cached only while conversations or their descendants work                       |
| [extra/usage-limits/](extra/usage-limits/usage-limits.ts) | Records the Claude and ChatGPT subscription usage limits that model responses report, for Settings                 |

The native [recurse_settings tool](core/settings/settings.ts) and
[artifact tool](core/environment/artifact.ts) use Pi Durable's `deferred` flag.
Their descriptions and schemas are absent from initial model requests and inline
codemode declarations. Agents discover settings
after reading the bundled [recurse-settings skill](../../skills/recurse-settings/SKILL.md),
using `searchTools("recurse_settings")`, `describeTool("recurse_settings")`, and
`tools.recurse_settings(...)`. The skill is available regardless of cwd; only its
name, description and location are injected. Discovery, skill reads and calls
remain in the transcript and captured provider requests. `add_remote` and
`list_remotes` call the same in-process connection operations as the Settings
routes; the native tool has no HTTP or credential access. Remote sign-in
remains operator-only. Artifacts
use the same discovery path, searching for `"create Artifact"`.

The settings tool changes the app's name with `set_name`/`reset_name` and its
PNG/SVG icon with `set_icon`/`reset_icon`, only when the operator asks. Icon
paths resolve against the tool cwd and are limited to 1 MiB. Reload applies
these instance settings.

The settings tool also offers `share_link` with local `conversations` ids. It
resolves children to their root trees, deduplicates roots, and returns a
`#trees=cid,cid` fragment to append to this instance's public URL. The link
includes whole trees and requires existing sign-in; it does not create public
access or change authentication.

## File search

Find and grep share one host-owned child process and bounded native pools.
Each conversation opens its cwd index lazily. Indexes have no filesystem watcher,
content-index build, or mmap warmup: file churn does no work between searches.
Fresh searches request a background metadata refresh when the index is at least
five minutes old; searches and pagination use the available snapshot without
waiting for that refresh. Initial scans and refreshes share one native scan slot
across conversations, including scans that exceed the initial wait timeout.
Cwd changes replace the main index, 30 minutes without searches releases all
of a conversation's indexes, and conversation shutdown closes its connection.
Git ignores and the native finder's standard exclusions bound each scan.
Callers can override refresh and idle intervals through
[FffFlags](extra/fff/fff_tools.ts); defaults remain unchanged. All memory mapping
stays disabled, and grep skips files of 256 KiB or more. A native crash rejects
pending searches with “File search crashed; retry”; the next request starts a
new child and rebuilds indexes lazily. Host shutdown drains searches and stops
the registered process group. The child exits when its parent IPC disconnects.

The [native-tool adapter](extra/fff/pi_tool_adapter.ts) shortens search help;
pi-fff's parameter validators and search execution stay unchanged.

## On-demand MCP tools

Each server in Settings > MCPs accepts `"loadToolsOnDemand": true`. The default
is `false`, listing tool names in the codemode section once that server connects.
With `true`, the server's tool descriptions and schemas stay out of inline
codemode sections even after connection. Agents discover them with `searchTools`
and `describeTool`, and call them from scripts as before. Both modes keep
`callers: ["tools"]`: MCP tools are never offered directly to the model. Saving
this option applies on the next turn, like other server settings.

Signed-in ChatGPT (Codex) models always use server compaction, saving an encrypted
server item instead of generating a readable summary.
The thread shows “Conversation compacted on the server.”; earlier messages remain
visible. Request capture exposes the encrypted item as a block. If the item is
unavailable after a model/account change or a rejection,
the next request generates a readable summary lazily from retained history. Forks
inherit items and history; the same matching and fallback rules apply. Promotion
remaps retained-history boundaries and uses a lazy summary in the new session. A failed
server compaction uses the normal readable-summary path. Rejections fail the
current turn without retrying it. Other providers use readable summaries.

## Subscription usage limits

[usage-limits.ts](extra/usage-limits/usage-limits.ts) wraps the Durable host's
shared models. Claude responses report 5-hour and weekly usage in
`anthropic-ratelimit-unified-*` headers; ChatGPT responses report them in
`x-codex-primary-*`/`x-codex-secondary-*` headers (SSE) or `codex.rate_limits`
events (WebSocket). The latest values per login are kept in `usage-limits.json`
in Pi's agent directory and shown in Settings' Claude and OpenAI sections. No
request is ever made just to read usage, and a login change drops its values.

## Rules for changes

- Add model capabilities as an extension here, not as a parallel runner or a
  Pi patch; Bun patches in `scripts/patches/` are a last resort.
- Request transforms change only model-bound copies, never the stored
  transcript. Extensions keep their own state in Durable documents and entries
  (for example denied reviews and compaction memos).
- Safety review runs before any side effect; shell rewriting (RTK) runs only
  after the original command is approved, and failures keep the reviewed
  command. Git commits retain their original output because RTK summaries drop
  commit-hook checks and diagnostics.
- RTK readiness is read asynchronously once per process and awaited before
  rewriting commands; the launcher owns the status file.
- Keep native and slow work (search, SQL) off the server's event loop.
