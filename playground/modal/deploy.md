# Deploy on Modal

`python3 playground/modal/deploy.py deploy NAME` runs one exact, pushed commit of
Recurse on Modal. The app's data and logins live on a Modal Volume, so a
redeploy keeps them. Everything Modal-specific lives in
[playground/modal/](README.md), which also explains how it works;
Recurse itself knows nothing about Modal. `python3 playground/modal/deploy.py
deploy --help` lists every option.

## Before you start

Install Git and Python, run `pip install modal==1.5.1`, then `modal setup`.
Deploy from a clean, pushed checkout. Redeploys do not need `gh`.

## First deployment

```sh
python3 playground/modal/deploy.py deploy myrecurse
```

This deploys the checkout's pushed HEAD; `--ref BRANCH|SHA` picks another
pushed commit. The source always comes from the configured HTTPS origin,
whichever repository the agents work on.

A new app creates the missing `NAME-data`, `NAME-auth` and `NAME-github`
resources. The GitHub token comes from `GITHUB_TOKEN`, `GH_TOKEN` or an
authenticated `gh`. A new password is written once to a new owner-only (0600)
file, `~/.config/recurse/deploy/NAME-password` by default (`--password-file`);
it is never printed. Read it privately, sign in, change it in Settings, and add
model logins in Settings. Existing resources and password files are never
overwritten; a failed setup may leave resources behind. A new app always gets a
new Volume; another app's Volume is refused. An app Modal no longer lists (for
example, stopped long ago) counts as existing when `NAME-data` exists, or when
you name all three existing resources, and is redeployed with them.

The first deployment saves the agents' repository URL (`CHAT_REPO_URL`), the
display name (`CHAT_APP_NAME`) and extra web-only Secrets
(`RECURSE_MODAL_WEB_EXTRA_SECRETS`) to `data/deploy-state/settings.json` on the
Volume. Unset values stay empty; the default display name is "Recurse". URLs may
not contain credentials, and extra Secrets must already exist.

## Updating and redeploying

Run the same command, with `--ref SHA` for a specific commit. An agent inside
the deployed app updates its own instance the same way, like any other command,
from a clean checkout of Recurse (for example its worktree):
`python3 playground/modal/deploy.py deploy NAME --ref SHA`. Every deploy runs in a
separate small app, `NAME-deployer`, which runs
`modal deploy --strategy recreate` of the pinned commit and then checks that the
new app reports that commit and that its web address shows the sign-in page.
The run continues if the command stops, including when the deployed app it runs
in restarts. Only one deploy runs at a time; a deploy that died releases its lock
within 3 minutes, and the next request simply redeploys.

Redeploys reuse the Volume's saved settings and ignore the caller's. An existing
app never creates missing resources; an app with non-default names must name
them, and they must exist:

```sh
python3 playground/modal/deploy.py deploy myrecurse --volume existing-data --auth-secret existing-auth --github-secret existing-github
```

An existing app without saved settings needs them imported once. Save this JSON
to a private file, filling in the repository URL, display name and existing
web-only Secret names (`null` means unset):

```json
{ "version": 1, "repoUrl": null, "displayName": null, "webExtraSecrets": [] }
```

Then run `python3 playground/modal/deploy.py settings-save NAME --file PATH --volume EXISTING_VOLUME`.
This only writes the Volume (`NAME-data` by default) and never deploys. It
refuses to replace a saved record unless you pass `--replace`; changes apply on
the next deployment.

## When a deployment fails

Check what happened, from any machine or Recurse instance with the Modal
credentials, even when the app itself is down:

```sh
python3 playground/modal/deploy.py status myrecurse
```

It only reads. It prints both apps' rows from `modal app list`, the last
deploy's commit, times, result, error, web address and last successful commit,
the log's path on the Volume and its last 40 lines. Full logs of the last 20
deploys stay in `data/deploy-state/logs/` on the Volume; `modal app logs NAME`
shows the running app.

Nothing redeploys automatically. To go back, redeploy the last good commit the
status shows: `python3 playground/modal/deploy.py deploy NAME --ref SHA`. A redeploy cannot undo Volume
or schema migrations.

## Moving an instance deployed by an older release

Older releases used a deploy controller (`recurse-deploy-controller-v2`) with
its own records under `data/deploy-state/slots/`. The current release ignores
those records and never moves an instance on its own. To move one, once:

1. Deploy a current commit with `python3 playground/modal/deploy.py deploy NAME --ref SHA` and the
   instance's resource names. If the Volume lacks `settings.json`, save it
   first (above). The first run creates `NAME-deployer`.
2. Confirm it with `python3 playground/modal/deploy.py status NAME`.
3. Stop the old controller App by its exact ID (`modal app list`, then
   `modal app stop ap-…`), so older checkouts cannot submit to it.

## Keeping the app awake

By default a schedule keeps the app awake so background work keeps running.
`--no-keepalive` is only for throwaway test deploys, which may sleep mid-work;
pass it on every such deploy. Running shells also keep the app warm.
