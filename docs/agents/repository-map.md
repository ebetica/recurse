This page is written for agents running inside Recurse; see the [human docs](../README.md).

# Code map

Before changing code, find the part below, read its README (if it has one), the
owning module's header, and its focused tests. Headers, implementation and tests
are authoritative; the [docs index](../README.md) explains how the parts fit together.

## Server

The backend is strict TypeScript on Bun. [src/server.ts](../../src/server.ts)
composes the server; `bun src/server.ts --check` composes it without listening.

| Part                                                                           | What it owns                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [src/agents/](../../src/agents/README.md)                                         | The agent tree, the supervisor, each agent's node, agent and conversation stores, deferred-action retry                                                                                          |
| [src/agents/durable/](../../src/agents/durable/README.md)                         | Pi Durable: one Harness per conversation (`host.ts`, lifecycles in `host/`), prompts, request capture, reports, compaction                                                                       |
| [src/agents/view/](../../src/agents/view/README.md)                               | Bounded conversation views served at `/view`                                                                                                                                                     |
| `src/agents/runtime/`                                                          | One agent's work: its node, prompts, provenance, memory index, temp directory. It never imports the coordination hubs above it                                                                   |
| [src/agents/runtime/attachments/](../../src/agents/runtime/attachments/README.md) | Each agent's uploaded and published files                                                                                                                                                        |
| `src/web/`                                                                     | The authenticated HTTP boundary (`Bun.serve`): routes, login throttling and CSRF. Agent work never runs in handlers                                                                              |
| `src/auth/`                                                                    | Login sessions, provider credentials and OAuth, inbound service principals, inbound backend keys (`backend_keys.ts`). Providers load lazily; keep `src/coding_backend/` off the auth import path |
| `src/backends/`                                                                | The home's connections to other backends: stored keys, the remote client, cached health. Cross-backend sends are relayed by `src/web/relay.ts`                                                   |
| `src/coding_backend/`                                                          | Tool environment, safety roots, skills, legacy session checks                                                                                                                                    |
| [src/artifacts/](../../src/artifacts/README.md)                                   | Artifacts: versioned documents and apps ([src/artifacts.ts](../../src/artifacts.ts))                                                                                                                |
| `src/tool_projection/`                                                         | Dependency-free, redacted summaries of tool calls; full payloads stay in `src/tool_details.ts`, never in hot conversation state                                                                  |
| `src/observability/`                                                           | Logs, event-loop lag, slow spans, startup metrics                                                                                                                                                |
| `src/utils/`                                                                   | Trash retirement (`trash.ts`), file locks, task sets, date-partition expiry                                                                                                                      |
| `src/themes/`, `src/media/`, `src/pull_request/`                               | Fonts and palettes, MIME data, patch parsing; each main module sits beside its directory                                                                                                         |

Single modules: [branding.ts](../../src/branding.ts) (instance name and icon),
[config.ts](../../src/config.ts) (instance settings and model
policy), [process_lifecycle.ts](../../src/process_lifecycle.ts) (process-group
cleanup), [deleted_bin.ts](../../src/deleted_bin.ts) (retained deletion),
[workdir_git.ts](../../src/workdir_git.ts) (Git queries by working folder),
[http_transport.ts](../../src/http_transport.ts) (compression),
[pi_bg_shell.ts](../../src/pi_bg_shell.ts) (detached-shell liveness),
[pi_auth_worker.mjs](../../src/pi_auth_worker.mjs) (Pi logins for Settings),
[push_notifications.ts](../../src/push_notifications.ts) (agent-finished Web Push),
[recurse_update.ts](../../src/recurse_update.ts) (Settings' update check and "Update now").
State written by the old Python release is refused at startup, naming the last
release that imports it.

## Extensions, tools and launch

| Part | What it owns |
| --- | --- |
| [src/extensions/](../../src/extensions/README.md) | Durable extensions: `src/extensions/core/{safety,shells,context,environment}/` and `src/extensions/extra/{fff,mcp,rtk,model-clock,codex}/` |
| [src/extensions/core/settings/](../../src/extensions/core/settings/settings.ts) | On-demand native effort-level and colour-theme tool |
| [tools/](../../tools/README.md) | Agent CLIs (subagents and worktrees) |
| [src/launcher/](../../src/launcher/README.md) | `./recurse`, `src/local.ts`, builds and where files live |
| [playground/modal/](../../playground/modal/README.md) | Self-contained Modal deployment (app, deploy tool, tests); Recurse imports nothing from it. Usage in [deploy.md](../../playground/modal/deploy.md) |
| `scripts/patches/` | Bun patches to pinned dependencies; prefer a Pi extension over a new patch |

Recurse runs on the user's Bun; `BUN_MIN_VERSION` in `src/local.ts` is mirrored in
the shell scripts, so change them together. Nothing needs Node, npm or Python,
and the server never changes an agent's `PATH`. Dependencies are pinned in
`package.json` and `bun.lock`; follow their policy comments. Anthropic OAuth registration
lives in `src/auth/anthropic_oauth.ts`, not an extension.

## Browser app and tests

| Part | What it owns |
| --- | --- |
| [web/](../../web/README.md) | The browser app: `web/app.ts`, built into `web/dist/` and loaded by `web/index.html` |
| [tests/](../../tests/README.md) | Backend, extension, web, browser and live tests; suite checks in `tests/checks/` and developer scripts in `tests/dev/` |
