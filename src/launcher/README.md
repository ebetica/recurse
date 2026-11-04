# Running Recurse locally

The launcher starts and supervises Recurse for a target project. `./recurse`
prepares the checkout and invokes [../local.ts](../local.ts), which holds the
data-directory lock and starts the server. The supervisor builds a new checkout
generation while the old server serves, then restarts when turns are idle.
Single-run and prebuilt modes bypass watching.

**Source files:** [../local.ts](../local.ts) selects launch mode and roots;
[supervisor.cli.ts](supervisor.cli.ts) watches and restarts;
[build.cli.ts](build.cli.ts) stages frontend builds; [update.ts](update.ts) runs
updates; [dependencies.ts](dependencies.ts) prepares dependencies;
[server_process.cli.ts](server_process.cli.ts) manages the server process;
[lock.cli.ts](lock.cli.ts) owns the launch lock; [git.ts](git.ts) prepares the target;
[../local_roots.ts](../local_roots.ts), [../build_dir.ts](../build_dir.ts)
and [../build_stamp.cli.ts](../build_stamp.cli.ts) define paths and build identity.
[environment.ts](environment.ts) supplies server-safe subprocess environments.

Launcher-only modules use `.cli.ts`; shared helpers stay checked by the
server-thread blocking rules. Public entrypoints keep their installed names.

## Updates and builds

The CLI and Settings update paths run the checkout's installer. The supervisor
then builds and validates the new generation before replacing the server.
Failed builds leave the last good frontend and server available. Old process
groups must be gone before restart. [frontend_assets.ts](frontend_assets.ts)
copies the browser assets used by both package and staged builds.

## File ownership

| Files                                                     | Owner and lifetime                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Recurse source                                            | The checkout; installation manages its own checkout.                               |
| Builds and dependencies                                   | Per checkout, rebuildable and removed with it.                                     |
| Provider logins and Pi settings                           | Recurse home, independent of the checkout.                                         |
| Conversations, worktrees, Artifacts and instance settings | The target project's data directory.                                               |
| Agent scratch                                             | Per agent, retained until deletion; local temporary files may not survive restart. |

Settings and project state do not live in the build directory. Managed Recurse
worktrees have private dependency installs; deployment images can serve a
prebuilt checkout with settings and data mounted separately.

## Rules for changes

- Keep launch, settings and project data lifetimes separate.
- Preserve the running generation on build or update failure, and verify
  process cleanup before replacing it.
- Test launch and install changes using the
  [install smoke test](../../docs/develop.md#testing-install-changes).
