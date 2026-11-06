# Recurse on Modal

This directory is self-contained: Recurse itself knows nothing about Modal and
imports nothing from here. Usage: [deploy.md](deploy.md).

- [modal_app.py](modal_app.py): the Modal app. Its image clones Recurse at a
  pinned commit, builds it and serves it with `bun src/local.ts --prebuilt`.
- [deploy.py](deploy.py): the tool. `deploy`, `status` and `settings-save`
  commands, plus the small `NAME-deployer` app that runs each deploy.
- [test_deploy.py](test_deploy.py): offline tests with a fake Modal SDK
  ([tests/modal.py](tests/modal.py)); `python3 playground/modal/test_deploy.py`,
  run separately from the core suite (see [deploy.md](deploy.md#tests)).

Always run these files as scripts (`python3 playground/modal/deploy.py …`):
Python puts the script's directory, not `playground/`, on `sys.path`, so this
folder does not shadow the `modal` SDK.

## The image and web container

The image adds Git, ripgrep, gh and Playwright browsers for agents. Optional
per-app apt and pip packages are installed in layers after the base image, from
settings saved on the Volume, not in git. Containers pin one commit with existing
secrets and the Volume. `Web.web` uses
the `NAME-web` label, so redeploys keep the web address (Modal may qualify it
with a region; nothing compares the address string). `RECURSE_MODAL_WEB_EXTRA_SECRETS`
lists existing web-only secrets.

The web container reloads the Volume, then starts Bun in its own process group
with `RECURSE_SLEEP_WHEN_IDLE=1`: when nobody uses the instance it tells
connected homes to stop polling for an hour, so the container gets no requests
and stops after its 10-minute `scaledown_window`
([src/backends/README.md](../../src/backends/README.md)).
Its exit hook allows 15 seconds for TERM, 3 for forced cleanup, 8 for the
Volume commit and 3 for the sleep check-in state: 29 of Modal's
[30-second exit grace](https://modal.com/docs/guide/lifecycle-functions#exit).
It commits only after the whole group exited cleanly.

## Sleep check-in

Homes would otherwise re-poll a sleeping instance every hour, starting the big
web container for its whole scale-down window each time. `sleep_check` (label
`NAME-sleep-check`) answers those re-polls instead: Bun gets its URL as
`RECURSE_SLEEP_CHECK_URL`. Recurse advertises it at sign-in and in sleep
answers; homes persist it and check it before startup and periodic relay polls.
It is a separate function with a bare image, no
Volume or secrets, 0.125 CPU/256 MiB and a 2-second scale-down window, reading
the `NAME-sleep-check` Dict:

- `awake`: a random token the web container writes before starting Bun.
- `asleep`: written by the exit hook after a successful Volume commit, from
  files Recurse already keeps: `{token, keys}` with, per backend key id, the
  stored SHA-256 digest (`backend-keys.json`) and whether `relay-queue.json`
  holds messages for a label that key's home polled with. At most 1,000 keys;
  no message content, names or plaintext keys.

`GET /api/relay/requests` with a home's backend key is refused (401) unless the
key's digest matches (constant-time). It answers `sleep_seconds` (another hour)
only if the asleep token equals the awake token, so the container stopped after
its last start, and nothing waits for that key. Otherwise, or if the Dict is
unreadable, the home polls the web URL, which starts the container. While the
awake/asleep tokens differ, it returns 503 rather than rejecting a key against
an old snapshot: keys issued by the current web container are not in that
snapshot yet. This endpoint answers only empty/sleep polls, not queued message
contents; a waiting message still requires the authenticated web poll. A crash
without the exit hook leaves the tokens unequal, so homes poll as before. The
start allows 5 seconds to write `awake` and look up the check-in URL; if that
fails, Bun runs without `RECURSE_SLEEP_CHECK_URL`, and homes paused before it
started may keep sleeping until this container exits and rewrites `asleep`
(a message queued for them meanwhile waits until then).

`RECURSE_TEMP_IN_DATA_DIR=1` keeps each agent's disposable scratch and saved
working directory on the Volume until deletion, including across deploys and
container restarts. `TMPDIR`/`TMP`/`TEMP` stay on fast container-local storage;
use worktrees or memory for durable work, not either scratch space.

## Deploying

There is one primitive: `modal deploy --strategy recreate` of `modal_app.py` at a
pinned 40-hex commit. Recreate stops the old containers, whose exit hooks commit
the Volume, before the new version serves. First install, update and recovery
all run it the same way, so redeploying a commit is safe to repeat.

`deploy.py deploy NAME` first checks, from the checkout it runs in, that the
source is clean and pushed and that the app's resources exist. Only a new app
gets `NAME-data`, `NAME-auth` (a new password in an exclusive 0600 file, hashed
with PBKDF2-SHA256 at 600,000 iterations, matching `src/auth/session.ts`),
`NAME-github` and saved settings. Then it:

1. Refuses if a deploy is running (see the lock below).
2. Runs `modal deploy deploy.py`, which refreshes the small `NAME-deployer` app
   from the caller's checkout. It is a separate app because recreating NAME would kill
   a deploy running inside NAME. Its default rolling strategy leaves running
   calls alone.
3. Spawns `deploy({id, sha, keepalive})` and waits for its result. The run
   continues if the caller stops, including when the caller is NAME itself.

The run fetches only `playground/modal/modal_app.py` at the commit (falling back
to the two older wrapper locations listed in `deploy.py`), reads the saved
settings from the mounted Volume, runs the primitive, and verifies: the new
app's `verify` function (tool self-test) must report the requested commit, the
address from `Web.web.get_web_url()` must answer `/` with 401 "Sign in" and
`/api/version` with 401, and the `sleep_check` address (if the commit has one)
must answer `/api/relay/requests` without a key with 401. 502/503 and connection errors are retried for 5 minutes.

## Status, log and lock

The run writes `data/deploy-state/status.json` on the Volume and commits it at
start, every 30 seconds and at the end:

```json
{
  "version": 1,
  "id": "uuid",
  "app": "NAME",
  "sha": "40-hex",
  "keepalive": true,
  "startedAt": "…Z",
  "heartbeatAt": "…Z",
  "finishedAt": null,
  "result": "running|succeeded|failed",
  "error": null,
  "url": null,
  "log": "data/deploy-state/logs/<start>-<sha12>.log",
  "logTail": "last 40 lines",
  "lastSucceededSha": "40-hex"
}
```

The full log of each run is kept under `data/deploy-state/logs/` (newest 20).
A `running` status with a heartbeat younger than 3 minutes is the lock. A run
that died stops heartbeating, so the next request after 3 minutes redeploys;
there is no state to repair. `deploy.py status` reads this file, the log and
`modal app list` without touching the apps.

Older releases' controller records (`data/deploy-state/slots/…`) and web-run
receipts are ignored; nothing reads or repairs them.

## Keeping the app warm

Fresh Durable work markers, unfinished intents and fresh running-shell records
keep the app warm through HTTP. Durable refreshes its marker once a minute while
tasks, queued input or reports remain, and removes it when idle; an open session
or recent SQLite/WAL writes alone do not keep the app warm. Bounded scans skip invalid files and include legacy
`data/pi_bg_shell_state` (or `PI_BG_SHELL_STATE_DIR`). Old records expire; restart
recovery resumes or retires intents. Each keepalive poke logs its reason and
matching file path. Warmth never decides ownership.
