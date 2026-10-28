# Running Recurse locally

`./recurse [TARGET]` checks for the user's Bun, records the RTK status, builds the
frontend once if it is missing, and hands its arguments to `bun src/local.ts`.
`src/local.ts` holds the data directory's lock and supervises the server: it watches
the checkout's Git HEAD, builds the new generation while the old one keeps
serving, and restarts the server once no turn is running. `--once` runs a single
server without watching; `--prebuilt` serves an already built image, such as
a deployment image.

`recurse update` runs the checkout's `install.sh --update` before any setup:
it moves the checkout in place along the channel `install.sh` recorded (the
newest release, a pinned version or a branch), and a running supervisor picks
up the moved HEAD as above. Settings' "Update now" reaches the same path: the
supervisor opens an IPC channel to the server it spawns, the server sends an
update request over it only for an operator session, and the supervisor runs
`install.sh --update`, then builds, validates and restarts, reporting each step
back for Settings. Update builds run the moved checkout's `src/launch_cli.ts`
in a fresh Bun process, so the running supervisor cannot reuse an older imported
asset copier or build implementation. The update build owns a process group;
its 35-minute outer deadline covers RTK, install and bundling budgets with room
for asset copies, and timeout kills nested workers with the build process.
A failed update or build keeps the current server running.
Isolated test installs (`RECURSE_ISOLATED_ROOT`) neither check for updates nor
accept Settings' "Update now"; Settings shows why updates are off.

**Source files:** [../local.ts](../local.ts) · [supervisor.ts](supervisor.ts)
(HEAD watching, restarts, crash backoff, Settings updates) ·
[update.ts](update.ts) (running `install.sh --update`/`--check`) · [build.ts](build.ts) (staged frontend
builds) · [dependencies.ts](dependencies.ts) (pinned dependency installs for
setup, launch and checks) · [server_process.ts](server_process.ts) · [lock.ts](lock.ts) ·
[git.ts](git.ts) (cloning the target once) · [system.ts](system.ts) ·
[../build_dir.ts](../build_dir.ts) · [../build_stamp.ts](../build_stamp.ts) ·
[../local_roots.ts](../local_roots.ts) · [../local_dependencies.ts](../local_dependencies.ts)

On every entrypoint, server startup resolves Git target commit identity in the
background, including migration of old `recurse-agent` clone settings. Existing Git config and explicit
author/committer environment settings take precedence; otherwise the clone records
the configured GitHub token's account and noreply email. Without either, no
identity is invented: Git refuses commits and the server logs a warning to set
`user.name` and `user.email` or configure a GitHub token. Account lookup never
delays startup; existing local-target identities are preserved. `prepareGitIdentity` in `src/git_identity.ts` also lets
other Git-writing entry points resolve identity before committing.

A failed build keeps the last good frontend; Git read errors keep the current
generation serving. Before a restart, the old server's process groups must be
gone. Testing launch or install changes:
[docs/develop.md](../../docs/develop.md#testing-install-changes).

[frontend_assets.ts](frontend_assets.ts) publishes shared browser assets for both
package builds and staged launcher builds, including [brand assets](../../web/brand/)
under `/static/brand/`.

## Where files live

Recurse keeps four kinds of files in four places. Each place has one owner and
one lifetime; build outputs and dependency directories belong to each checkout.

| Files                                                                                                                                                                          | Where                                                                                                                                                                | Lifetime                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Recurse source                                                                                                                                                                 | the checkout you run `./recurse` from; `install.sh` puts it at `~/recurse` and links `~/.local/bin/recurse` to it                                                    | yours                                          |
| everything Recurse builds: the RTK status (`.rtk-status`), `.build-stamp.json`; Pi and pi-fff, installed by `bun install` from `bun.lock` with the fixes in `scripts/patches/` | `<checkout>/.recurse/` (gitignored); `node_modules/` (Pi, pi-fff, the extensions' dependencies, frontend packages) and `web/dist/` sit beside it where Bun puts them | rebuildable; gone when the checkout is deleted |
| persistent settings: provider logins and Pi settings in `pi-agent/`, rtk history in `rtk/`                                                                                     | `$RECURSE_HOME`, default `$XDG_CONFIG_HOME/recurse` or `~/.config/recurse`                                                                                           | survives reinstalls and checkout deletion      |
| one project's data: conversations, the agent tree, Pi session files, worktrees, Artifacts, uploads, instance `config/`                                                         | `$CHAT_DATA_DIR`, default `<target repo>/.recurse-data`                                                                                                              | belongs to the project                         |

### Rules that follow from this

- The build directory is derived from the source file location
  (`src/build_dir.ts`), never from configuration. Two checkouts cannot share
  executables, so a stale build can only be the checkout's own.
- A build is current when the checkout's Git HEAD, its dirty build inputs, and
  the pinned tool versions match `.recurse/.build-stamp.json`
  (`src/build_stamp.ts`). A clean match skips every install and build step;
  anything else rebuilds on the next `./recurse`. The check also requires every
  source brand asset in `web/dist/brand/`: an older running supervisor can build
  a moved HEAD with its previous asset copier and stamp an incomplete frontend.
  The updated launcher rejects that stamp and rebuilds before serving.
  Uncommitted edits are not
  watched: restart to build them.
- Managed worktrees of Recurse link `node_modules` to a private install under
  `/tmp/recurse/recurse-<instance>/dependencies/`. Entry and subagent creation
  prepare it automatically; setup, checks and launch restore a missing install
  after local disk is wiped. Re-entering a worktree already held by your agent
  also restores it. Changed dependency inputs rebuild only that checkout's
  install. The detached worktree sweeper retires and reclaims it with the
  checkout. Ordinary checkouts and other managed projects keep their existing
  dependency layout. Bun's local global cache retains normal hardlink behaviour:
  adding dependencies changes only one directory tree, but editing a package
  file in place can affect another cache-linked install.
- Durable extensions live under `src/extensions/core/` and `src/extensions/extra/`,
  loaded from source by the server.
  They have no package installs of their own; dependencies live in root
  `node_modules/`, and tests mirror the layout in `tests/extensions/`.
- Pi Durable runs inside the server process from `node_modules`; Pi needs no
  Node.js or npm. Recurse installs no `pi` command on the user's `PATH` and
  adds nothing to it.
- Settings never live under the checkout or the build directory, and the build
  directory never holds state. `PI_CODING_AGENT_DIR`, when set, must be inside
  `$RECURSE_HOME` (`src/local_roots.ts` checks both).
- Agents' disposable scratch files go to `$RECURSE_AGENT_TMPDIR`, kept across
  server restarts until the agent is deleted. Durable work belongs in worktrees
  or memory. The instance scope is stable for the data directory, and each
  agent lifetime has a persisted nonce so reused ids cannot adopt old scratch.
  Startup retires orphaned scratch; deletion and reap retire it with `retire`.
  By default it lives under `/tmp/recurse`; deployments with ephemeral `/tmp`
  set `RECURSE_TEMP_IN_DATA_DIR=1` to keep scratch in the data
  directory. `TMPDIR`/`TMP`/`TEMP` remain fast per-agent local scratch that a
  container restart may clear.
- A deployment image bakes one checkout with its `.recurse/` and mounts only
  settings and data; the container serves without installing or building.

Nothing reads `~/.recurse`; an old one can be deleted.
