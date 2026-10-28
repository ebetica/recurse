# Develop Recurse

Run `./recurse` with no target in a Recurse checkout (or `recurse` after
installing) to develop Recurse itself. The launcher watches the checkout's Git
HEAD: a new commit rebuilds and restarts the server once no turn is running.
Uncommitted edits are not watched; restart to try them.

For the agent workflow, evidence tiers, review and test-writing rules, see
[Develop Recurse for agents](agents/develop.md).

## How Recurse is developed

- Development happens in the private repository ebetica/recurse-dev, by
  agents and pull requests into its `dev` branch; `dev` is promoted to `main`.
- Releases are synced to the public repository ebetica/recurse with
  [scripts/release.ts](../scripts/release.ts), one commit per release.
- Pull requests to the public repository are closed automatically
  ([CONTRIBUTING.md](../CONTRIBUTING.md)). Public issues with exact details are
  handed to agents, which fix them in recurse-dev.

## Validation

`tests/check.sh` defines the CI-equivalent suite. Never run stages concurrently.
Read tests/check.sh and test headers for environment quirks. tests/check.sh unsets
CHAT_REPO_URL and RECURSE_SELF_DEPLOY; unset them when running individual tests too.

```bash
tests/check.sh web       # Prettier, design checks, Oxlint, frontend tests/types/build
tests/check.sh ts        # size limits, comment/test policy, backend Prettier/types/tests
tests/check.sh browser   # rebuild web/dist, Playwright tests
tests/check.sh provider  # reply-path tests against recorded providers
tests/check.sh           # web, ts and browser in order
```

The Artifact browser group exercises commit hooks through real RTK as well as
bash/codemode. It requires RTK 0.43.0 or newer on PATH; CI installs the pinned,
checksum-verified binary before the browser stage.

## Testing install changes

Changes to launch or install (`install.sh`, `./scripts/setup.sh`, `scripts/ensure-*.sh`,
`recurse`, `src/local.ts`, local dependencies, or managed artifacts) need a local
smoke test on a fresh install, besides the full suite. CI does not replace it.

1. Make a private temporary root. Point `HOME`, `RECURSE_HOME`,
   `RECURSE_CODE_HOME`, the config and the target repo inside it; never use real
   config or credentials.
2. Build from a minimal environment with `RECURSE_ISOLATED_ROOT` set to that
   root. Startup must reject state paths that escape it, inherited credentials,
   and inherited file descriptors.
3. Run the fresh-install path the change affects. Check the `recurse` command
   and the managed Pi artifacts.
4. Start the app and check that `/` and one `/api` response work.
5. Stop the processes and remove exactly the temporary resources you made.

## Releases

A release is a version in `package.json`, a `vX.Y.Z` tag in both repositories,
and notes in the public repository's GitHub Release. `recurse --version` and
the Settings header show the version and, in a Git checkout, the commit
([src/release.ts](../src/release.ts)).

Run `bun /path/to/scripts/release.ts X.Y.Z` from anywhere. It makes a fresh
temporary clone of recurse-dev main, bumps the version only when needed, and
drafts notes from first-parent subjects since the last version tag. Supply
`--notes FILE` to use written notes; in a terminal, `$VISUAL` or `$EDITOR`
(default `vi`) opens the notes before building. The public commit has the
same tree and the current public main as parent (no parent for an empty repo).
Commits and annotated tags use your Git identity, or your GitHub account.

The script shows both commits' identities, the public tree diff and notes,
then stops without pushing. It retains the clone and built refs and prints a
separate `X.Y.Z --push --prepared DIR` command. This command shows the saved
build again and requires typing the version in an interactive terminal;
noninteractive publication is refused. It pushes the development tag and any
version bump, atomically pushes public main and tag, then creates the GitHub
Release. A failure after a push is reported, not rolled back across repositories.

Use `--replace` when building to replace an existing release: the new public
commit uses that release's parent (or main's parent when the tag is absent),
including a root commit for the first release. Publishing checks exact saved
remote SHAs with force-with-lease; replacing an existing GitHub Release updates
its notes. `--dev-remote URL` and `--public-remote URL` override clone/push remotes;
GitHub Release publication targets ebetica/recurse. See `--help` for the short
command reference. The retained temporary directory can be deleted after use.

`install.sh` installs the newest `vX.Y.Z` tag of the public repository, or
`main` until one exists. `RECURSE_VERSION=0.1.0` pins a release and
`RECURSE_BRANCH=main` tracks a branch; rerunning `install.sh` updates an
existing install the same way. The checkout records its channel, and
`recurse update` (`install.sh --update`) updates it in place along that
channel; `recurse update --check` only reports. A running Recurse checks its
channel at most once a day and offers "Update now" in Settings, which updates,
rebuilds and restarts it once no turn is running
([src/recurse_update.ts](../src/recurse_update.ts)). A checkout made from the development history
moves to a release tag, but cannot fast-forward to the public `main`; reinstall
it into a new `RECURSE_INSTALL_DIR` to track that branch.
