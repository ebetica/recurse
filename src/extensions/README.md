# Extensions

Extensions add tools and request changes to Pi Durable. The Durable host imports
them from source ([src/agents/durable/host/runtime.ts](../agents/durable/host/runtime.ts));
they have no package installs of their own and use the root `node_modules/`.
Tests mirror this layout in `tests/extensions/`, and `tests/check.sh ts` runs them.

`core/` holds what every conversation needs; `extra/` holds the rest.

| Directory                                              | What it does                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| [core/safety/](core/safety/README.md)                  | Reviews every side-effecting tool call with a reviewer model before it runs                                        |
| [core/shells/](core/shells/README.md)                  | The `bash` and `wait` tools: detached shells, background commands and monitors                                     |
| [core/context/](core/context/context.ts)               | Context limits, compaction ([durable-compaction.ts](core/context/durable-compaction.ts)) and bounded search output |
| [core/environment/](core/environment/managed_tools.ts) | Working folder, environment, attachments and Artifacts (native `env`, `chdir`, `publish` and `artifact` tools)     |
| [extra/fff/](extra/fff/fff.ts)                         | Fast file search (`grep`, `find`, `multi_grep`) on one shared Worker thread                                        |
| [extra/mcp/](extra/mcp/mcp.ts)                         | MCP servers configured in Settings; agents call them from code-mode scripts                                        |
| [extra/rtk/](extra/rtk/rtk.ts)                         | Rewrites an approved shell command through RTK to shorten its output                                               |
| [extra/model-clock/](extra/model-clock/model-clock.ts) | Adds the current time to model-bound copies of messages                                                            |
| [extra/codex/](extra/codex/codex.ts)                   | Request clean-up for ChatGPT (Codex) models                                                                        |

The native [recurse_settings tool](core/settings/settings.ts) and
[artifact tool](core/environment/artifact.ts) use Pi Durable's `deferred` flag.
Their descriptions and schemas are absent from initial model requests and inline
codemode declarations. Agents discover settings
with codemode's `searchTools("effort levels colour themes")`, inspect it with
`describeTool("recurse_settings")`, and call `tools.recurse_settings(...)`.
Discovery and calls remain in the transcript and captured provider requests;
no skill, settings HTTP access, or additional permissions are needed. Artifacts
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

## On-demand MCP tools

Each server in Settings > MCPs accepts `"loadToolsOnDemand": true`. The default
is `false`, preserving inline codemode declarations once that server connects.
With `true`, the server's tool descriptions and schemas stay out of inline
codemode sections even after connection. Agents discover them with `searchTools`
and `describeTool`, and call them from scripts as before. Both modes keep
`callers: ["tools"]`: MCP tools are never offered directly to the model. Saving
this option applies on the next turn, like other server settings.

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
- Keep native and slow work (search, SQL) off the server's event loop.
