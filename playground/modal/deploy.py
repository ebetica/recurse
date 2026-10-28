"""Deploy a pushed Recurse commit on Modal and show the last deploy.

Every deploy runs `modal deploy --strategy recreate` of modal_app.py at a pinned
commit inside NAME-deployer, a separate app, so recreating NAME never kills it.
One run at a time: a running status whose heartbeat is younger than
LOCK_SECONDS holds the lock, and a dead run's lock expires on its own.
Status and logs live on the Volume; old deploy-state slots are never read.
Usage: python3 playground/modal/deploy.py COMMAND --help"""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import modal

TARGET = os.environ.get("RECURSE_MODAL_APP", "unset")
VOLUME_NAME = os.environ.get("RECURSE_MODAL_VOLUME", f"{TARGET}-data")
GITHUB_SECRET = os.environ.get("RECURSE_MODAL_GITHUB_SECRET", f"{TARGET}-github")
CONFIG = ("APP", "VOLUME", "AUTH_SECRET", "GITHUB_SECRET", "REPO_URL")
STATE = "data/deploy-state"
STATUS = f"{STATE}/status.json"
LOCK_SECONDS = 180
HEARTBEAT_SECONDS = 30
DEPLOY_SECONDS = 25 * 60
VERIFY_SECONDS = 300
KEEP_LOGS = 20
TAIL_LINES = 40
WRAPPERS = ("playground/modal/modal_app.py", "modal-deploy/modal_app.py", "deploy/modal_app.py")
NAME_RE = r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}"
PBKDF2_ITERS = 600_000
_CRED_HELPER = '!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f'

app = modal.App(f"{TARGET}-deployer")
volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=False)
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git")
    .pip_install("modal==1.5.1")
    .env({**{f"RECURSE_MODAL_{key}": os.environ.get(f"RECURSE_MODAL_{key}", "") for key in CONFIG},
          "MODAL_ENVIRONMENT": "main"})
)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _age(stamp: str) -> float:
    then = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - then).total_seconds()


def busy(status: dict | None) -> bool:
    """True while another run holds the lock; a stale heartbeat releases it."""
    return bool(status) and status.get("result") == "running" and _age(status["heartbeatAt"]) < LOCK_SECONDS


def _write(root: Path, relative: str, text: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text)
    os.replace(temporary, path)


def _tail(text: str) -> str:
    return "\n".join(text.splitlines()[-TAIL_LINES:])


def _wrapper(sha: str, scratch: Path, log) -> Path:
    """Fetch only the pinned commit and return its Modal wrapper."""
    git = ["git", "-c", f"credential.helper={_CRED_HELPER}", "-C", str(scratch)]
    subprocess.run(["git", "init", "-q", str(scratch)], check=True, stdout=log, stderr=log)
    subprocess.run([*git, "fetch", "-q", "--depth=1", os.environ["RECURSE_MODAL_REPO_URL"], sha],
                   check=True, stdout=log, stderr=log, timeout=300)
    if subprocess.check_output([*git, "rev-parse", "FETCH_HEAD"], text=True).strip() != sha:
        raise RuntimeError(f"fetched commit is not {sha}")
    wrapper = scratch / "modal_app.py"
    for path in WRAPPERS:
        shown = subprocess.run([*git, "show", f"{sha}:{path}"], capture_output=True)
        if shown.returncode == 0:
            wrapper.write_bytes(shown.stdout)
            return wrapper
    raise RuntimeError(f"{sha} has no Modal wrapper ({' or '.join(WRAPPERS)})")


def _environment(root: Path, sha: str, keepalive: bool) -> dict:
    """The wrapper's inputs: fixed resources plus the saved settings."""
    try:
        settings = json.loads((root / STATE / "settings.json").read_text())
    except FileNotFoundError:
        raise RuntimeError(f"Missing deployment settings; run deploy.py settings-save {TARGET}") from None
    if not isinstance(settings, dict) or settings.get("version") != 1:
        raise RuntimeError("Invalid deployment settings record")
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("RECURSE_MODAL_") and key not in ("CHAT_REPO_URL", "CHAT_APP_NAME", "GITHUB_TOKEN")}
    env.update({f"RECURSE_MODAL_{key}": os.environ[f"RECURSE_MODAL_{key}"] for key in CONFIG})
    env.update(RECURSE_MODAL_CONFIRMED_VOLUME=os.environ["RECURSE_MODAL_VOLUME"], RECURSE_MODAL_PIN=sha,
               RECURSE_MODAL_KEEPALIVE="1" if keepalive else "0",
               RECURSE_MODAL_WEB_EXTRA_SECRETS=json.dumps(settings.get("webExtraSecrets", [])))
    if settings.get("repoUrl"):
        env["CHAT_REPO_URL"] = settings["repoUrl"]
    if settings.get("displayName"):
        env["CHAT_APP_NAME"] = settings["displayName"]
    return env


def _get(url: str) -> tuple[int, str]:
    request = urllib.request.Request(url, headers={"User-Agent": "recurse-deployer"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read(65536).decode(errors="replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read(65536).decode(errors="replace")


def verify(sha: str, log) -> str:
    """Require the requested commit and a web address answering sign-in."""
    report = modal.Function.from_name(TARGET, "verify").remote()
    if report.get("image_pin") != sha:
        raise RuntimeError(f"verify: deployed commit {report.get('image_pin')} is not {sha}")
    url = modal.Cls.from_name(TARGET, "Web")().web.get_web_url()
    deadline = time.monotonic() + VERIFY_SECONDS
    for path in ("/", "/api/version"):
        while True:
            try:
                code, body = _get(urllib.parse.urljoin(url, path))
            except (urllib.error.URLError, OSError) as error:
                code, body = 0, str(error)
            if code not in (0, 502, 503) or time.monotonic() > deadline:
                break
            time.sleep(2)
        print(f"[verify] GET {path} -> {code}", file=log, flush=True)
        if code != 401 or (path == "/" and "Sign in" not in body):
            raise RuntimeError(f"verify: GET {path} returned {code}, not the sign-in page")
    return url


def run(root: Path, request: dict, reload, commit) -> dict:
    """Deploy request["sha"] unless a live run holds the lock; return status."""
    sha = request["sha"]
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("A full 40-hex commit is required")
    reload()
    status_file = root / STATUS
    previous = json.loads(status_file.read_text()) if status_file.exists() else None
    if busy(previous):
        return {**previous, "refused": "another deploy is running"}
    started = _now()
    status = {"version": 1, "id": request["id"], "app": TARGET, "sha": sha,
              "keepalive": request["keepalive"], "startedAt": started, "heartbeatAt": started,
              "finishedAt": None, "result": "running", "error": None, "url": None,
              "log": f"{STATE}/logs/{started.replace('-', '').replace(':', '')}-{sha[:12]}.log",
              "logTail": "", "lastSucceededSha": (previous or {}).get("lastSucceededSha")}

    saving = threading.Lock()
    finished = threading.Event()

    def save(local: Path) -> None:
        with saving:
            text = local.read_text(errors="replace")
            _write(root, status["log"], text)
            status["logTail"] = _tail(text)
            _write(root, STATUS, json.dumps(status, indent=2))
            commit()

    def heartbeat(local: Path) -> None:
        while not finished.wait(HEARTBEAT_SECONDS):
            status["heartbeatAt"] = _now()
            try:
                save(local)
            except Exception as error:
                print(f"[deployer] heartbeat save failed: {error!r}", file=sys.stderr)

    with tempfile.TemporaryDirectory(prefix="recurse-deployer-") as scratch:
        local = Path(scratch) / "deploy.log"
        local.touch()
        save(local)
        beating = threading.Thread(target=heartbeat, args=(local,), daemon=True)
        beating.start()
        try:
            with local.open("a") as log:
                wrapper = _wrapper(sha, Path(scratch) / "source", log)
                print(f"[deployer] modal deploy --strategy recreate {sha}", file=log, flush=True)
                child = subprocess.Popen(["modal", "deploy", "--strategy", "recreate", str(wrapper)],
                                         stdout=log, stderr=subprocess.STDOUT,
                                         env=_environment(root, sha, request["keepalive"]), start_new_session=True)
                try:
                    code = child.wait(timeout=DEPLOY_SECONDS)
                except subprocess.TimeoutExpired:
                    raise RuntimeError("modal deploy timed out") from None
                finally:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    child.wait()
                if code:
                    raise RuntimeError(f"modal deploy exited {code}")
                status["url"] = verify(sha, log)
            status.update(result="succeeded", lastSucceededSha=sha)
        except Exception as error:
            status.update(result="failed", error=f"{type(error).__name__}: {error}"[:1000])
        finished.set()
        beating.join()
        status["finishedAt"] = status["heartbeatAt"] = _now()
        logs = sorted((root / STATE / "logs").glob("*.log"))
        for old in logs[:-KEEP_LOGS]:
            old.unlink()
        save(local)
    return status


@app.function(image=image, volumes={"/vol": volume}, timeout=DEPLOY_SECONDS + VERIFY_SECONDS + 300,
              max_containers=1, retries=0,
              secrets=[modal.Secret.from_name(GITHUB_SECRET, required_keys=["GITHUB_TOKEN"])])
def deploy(request: dict) -> dict:
    return run(Path("/vol"), request, volume.reload, volume.commit)


def _saved(volume_name: str, path: str) -> str | None:
    try:
        return b"".join(modal.Volume.from_name(volume_name).read_file(path)).decode(errors="replace")
    except FileNotFoundError:
        return None


def _summary(status: dict, volume_name: str) -> None:
    print(f"Last deploy: {status['result']}" + (f" ({status['refused']})" if status.get("refused") else ""))
    print(f"  commit    {status['sha']}")
    print(f"  started   {status['startedAt']}   finished {status['finishedAt'] or '-'}   heartbeat {status['heartbeatAt']}")
    for label, key in (("error", "error"), ("url", "url")):
        if status.get(key):
            print(f"  {label:<9} {status[key]}")
    if status.get("lastSucceededSha"):
        print(f"  last good {status['lastSucceededSha']}  (deploy.py deploy {status['app']} --ref {status['lastSucceededSha']})")
    print(f"  log       {status['log']} on Volume {volume_name}")


def show(name: str, volume_name: str) -> None:
    """Print app state, the status file and the log tail; reads only."""
    try:
        apps = json.loads(subprocess.check_output(["modal", "app", "list", "--json"], timeout=60))
        for app_name in (name, f"{name}-deployer"):
            rows = [row for row in apps if row.get("description") == app_name]
            print(f"App {app_name}: {json.dumps(rows) if rows else 'not found'}")
    except Exception as error:
        print(f"App list unavailable: {type(error).__name__}: {error}")
    text = _saved(volume_name, STATUS)
    if text is None:
        print(f"No deploy recorded in {STATUS} on Volume {volume_name}")
        return
    status = json.loads(text)
    _summary(status, volume_name)
    log = _saved(volume_name, status["log"])
    print(f"--- last {TAIL_LINES} log lines ---")
    print(_tail(log) if log is not None else status["logTail"])
    print(f"More: modal app logs {name}; modal app logs {name}-deployer")


def _owned(args, timeout: int, **kwargs) -> tuple[int, str, str]:
    """Run a command in its own process group, which is killed on any exit."""
    pipe = subprocess.PIPE
    child = subprocess.Popen(args, stdout=pipe, stderr=pipe, text=True, start_new_session=True, **kwargs)
    try:
        out, err = child.communicate(timeout=timeout)
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
    return child.returncode, out or "", err or ""


def _redact(text: str) -> str:
    parts = {part for key, value in os.environ.items()
             if re.search(r"token|secret|password|auth|key", key, re.I) for part in value.splitlines()}
    for part in sorted(filter(str.strip, parts), key=len, reverse=True):
        text = text.replace(part, "REDACTED")
    return re.sub(r"\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})", "REDACTED", text)


def _run(*args: str, timeout: int = 300, **kwargs) -> str:
    """Run a short command; failures show its stderr tail without secrets."""
    code, out, err = _owned(args, timeout, **kwargs)
    if code:
        raise SystemExit(f"{' '.join(args[:2])} failed (exit {code}): {_redact(err).strip()[-2000:]}")
    return out.strip()


def _name(value: str) -> str:
    if not re.fullmatch(NAME_RE, value):
        raise SystemExit("Names must be 1-64 letters, digits, dots, underscores or hyphens.")
    return value


def _https(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    if (parts.scheme != "https" or not parts.hostname or parts.username or parts.password
            or parts.query or parts.fragment):
        raise SystemExit("Repository URLs must be HTTPS without embedded credentials.")
    return url


def settings_record(record) -> dict:
    """Validate a version-1 settings record; it never holds credentials."""
    keys = {"version", "repoUrl", "displayName", "webExtraSecrets"}
    if not isinstance(record, dict) or set(record) != keys:
        raise SystemExit("Invalid settings: use version 1 with repoUrl, displayName and webExtraSecrets.")
    name, extra = record["displayName"], record["webExtraSecrets"]
    if (record["version"] != 1 or not (record["repoUrl"] is None or isinstance(record["repoUrl"], str))
            or not (name is None or (isinstance(name, str) and name.strip() and len(name) <= 256
                                     and not re.search(r"[\x00-\x1f\x7f]", name)))
            or not isinstance(extra, list) or len(extra) > 32
            or any(not isinstance(item, str) or not re.fullmatch(NAME_RE, item) for item in extra)
            or len(set(extra)) != len(extra) or len(json.dumps(record)) > 8192):
        raise SystemExit("Invalid settings: use version 1 with repoUrl, displayName and webExtraSecrets.")
    if record["repoUrl"] is not None:
        _https(record["repoUrl"])
    return record


def _save_settings(volume_name: str, record: dict, replace: bool = False) -> None:
    with tempfile.TemporaryDirectory() as scratch:
        local = Path(scratch) / "settings.json"
        local.write_text(json.dumps(record))
        with modal.Volume.from_name(volume_name).batch_upload(force=replace) as batch:
            batch.put_file(str(local), f"{STATE}/settings.json", mode=0o600)


def _inventory(kind: str) -> list[dict]:
    rows = json.loads(_run("modal", kind, "list", "--json"))
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise SystemExit(f"Unexpected modal {kind} list response.")
    return rows


def source(root: Path, ref: str | None) -> tuple[str, str]:
    """Return the pinned commit and HTTPS origin of clean, pushed source."""
    def git(*args: str) -> str:
        return _run("git", "-C", str(root), *args, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    if git("status", "--porcelain"):
        raise SystemExit("Deployment requires a clean tree; commit or remove your changes first.")
    if ref:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9/._-]*", ref):
            raise SystemExit("Invalid --ref.")
        git("fetch", "origin", ref)
        pin = git("rev-parse", "FETCH_HEAD^{commit}")
    else:
        pin = git("rev-parse", "HEAD")
        git("fetch", "--prune", "origin")
        if not git("for-each-ref", "--format=%(refname)", f"--contains={pin}", "refs/remotes/origin/"):
            raise SystemExit("HEAD is not pushed to origin; push this commit before deploying.")
    if not any(subprocess.run(["git", "-C", str(root), "cat-file", "-e", f"{pin}:{path}"],
                              capture_output=True).returncode == 0 for path in WRAPPERS):
        raise SystemExit(f"{pin} has no Modal wrapper; deploy a commit with {WRAPPERS[0]}.")
    url = re.sub(r"^git@github\.com:", "https://github.com/", git("config", "--get", "remote.origin.url"))
    return pin, _https(url)


def _password(path: Path) -> dict:
    """Write a new password to an exclusive 0600 file; return its verifier."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    password = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as out:
        out.write(password + "\n")
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ITERS, 32)
    return {"CHAT_AUTH_SALT": salt, "CHAT_AUTH_HASH": digest.hex()}


def _create_secret(name: str, values: dict) -> None:
    with tempfile.TemporaryDirectory() as scratch:
        local = Path(scratch) / "secret.json"
        local.write_text(json.dumps(values))
        local.chmod(0o600)
        _run("modal", "secret", "create", name, "--from-json", str(local))
    print(f"Created secret {name}")


def prepare(options) -> tuple[str, str]:
    """Check source and resources; create them only for a new app."""
    name = options.name
    volume, auth, github = options.volume, options.auth_secret, options.github_secret
    for tool in ("git", "modal"):
        if not shutil.which(tool):
            raise SystemExit(f"Install {tool} first (pip install modal==1.5.1; modal setup).")
    pin, url = source(Path(__file__).resolve().parents[2], options.ref)
    if not options.keepalive:
        print("WARNING: NO KEEPALIVE: this instance may sleep during background work.", file=sys.stderr)
    listed = any(row.get("description") == name for row in _inventory("app"))
    secret_names = {row.get("name") for row in _inventory("secret")}
    has_volume = any(row.get("name") == volume for row in _inventory("volume"))
    explicit = options.explicit_volume and options.explicit_auth and options.explicit_github
    if not listed and has_volume and volume != f"{name}-data" and not explicit:
        raise SystemExit(f"Volume {volume} may belong to another app. A new app gets its own {name}-data; "
                         "to redeploy an app Modal no longer lists, name all three existing resources.")
    existing = listed or has_volume
    if not existing and os.environ.get("MODAL_TASK_ID") and os.environ.get("RECURSE_MODAL_APP") == name:
        raise SystemExit("Cannot bootstrap the calling app.")
    for kind, selected, present, override in (
            ("Volume", volume, has_volume, options.explicit_volume),
            ("auth secret", auth, auth in secret_names, options.explicit_auth),
            ("GitHub secret", github, github in secret_names, options.explicit_github)):
        if not present and (existing or override):
            raise SystemExit(f"Missing {kind} {selected}. Existing apps and explicit names never create replacements.")
    print(f"App {name}; {'existing resources only' if existing else 'new deployment'}; source pin {pin}")
    if not existing:
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
        if github not in secret_names and not token and shutil.which("gh"):
            token = _run("gh", "auth", "token")
        if github not in secret_names and not token:
            raise SystemExit("A GitHub token is required: gh auth login, or set GITHUB_TOKEN privately.")
        record = settings_record({"version": 1, "repoUrl": os.environ.get("CHAT_REPO_URL") or None,
                                  "displayName": os.environ.get("CHAT_APP_NAME") or None,
                                  "webExtraSecrets": json.loads(os.environ.get("RECURSE_MODAL_WEB_EXTRA_SECRETS", "[]"))})
        missing = [item for item in record["webExtraSecrets"] if item not in secret_names]
        if missing:
            raise SystemExit(f"Missing existing web extra secrets: {', '.join(missing)}")
        if auth not in secret_names:
            path = Path(options.password_file or Path.home() / ".config/recurse/deploy" / f"{name}-password").resolve()
            _create_secret(auth, _password(path))
            print(f"Password saved privately to {path}; read it locally, rotate it in Settings.")
        if github not in secret_names:
            _create_secret(github, {"GITHUB_TOKEN": token})
        _run("modal", "volume", "create", volume)
        print(f"Created Volume {volume}")
        _save_settings(volume, record)
    return pin, url


def start(options, pin: str, repo: str) -> int:
    """Refresh the deployer app, run one deploy and wait for its result."""
    name = options.name
    text = _saved(options.volume, STATUS)
    if text and busy(json.loads(text)):
        print(f"A deploy is already running; see deploy.py status {name}", file=sys.stderr)
        return 1
    os.environ.update({"RECURSE_MODAL_APP": name, "RECURSE_MODAL_VOLUME": options.volume,
                       "RECURSE_MODAL_AUTH_SECRET": options.auth_secret,
                       "RECURSE_MODAL_GITHUB_SECRET": options.github_secret,
                       "RECURSE_MODAL_REPO_URL": repo})
    code, out, err = _owned(["modal", "deploy", str(Path(__file__).resolve())], 900)
    print(_redact(out + err).strip()[-4000:], flush=True)
    if code:
        raise SystemExit(f"Refreshing {name}-deployer failed (exit {code}); see the output above.")
    request = {"id": str(uuid.uuid4()), "sha": pin, "keepalive": options.keepalive}
    call = modal.Function.from_name(f"{name}-deployer", "deploy").spawn(request)
    print(f"Deploy {request['id']} of {pin} started; it continues if this command stops.\n"
          f"Check it with python3 playground/modal/deploy.py status {name}", flush=True)
    status = call.get(timeout=DEPLOY_SECONDS + VERIFY_SECONDS + 600)
    _summary(status, options.volume)
    print(status["logTail"])
    return 0 if status["result"] == "succeeded" and not status.get("refused") else 1


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="deploy.py", description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    deploy_parser = commands.add_parser(
        "deploy", help="deploy a pushed commit (first install, update or recovery)",
        description="Deploy a pushed commit through NAME-deployer and wait. A new app gets NAME-data, NAME-auth "
                    "and NAME-github and saves CHAT_REPO_URL, CHAT_APP_NAME and RECURSE_MODAL_WEB_EXTRA_SECRETS; "
                    "existing apps never create resources and reuse the Volume's saved settings.")
    status_parser = commands.add_parser("status", help="show both apps, the last deploy and its log (read-only)")
    settings_parser = commands.add_parser("settings-save", help="import a settings JSON record; never deploys")
    for sub in (deploy_parser, status_parser, settings_parser):
        sub.add_argument("name")
        sub.add_argument("--volume", help="existing Volume (default NAME-data)")
    deploy_parser.add_argument("--ref", help="pushed branch or SHA (default: clean, pushed HEAD)")
    deploy_parser.add_argument("--auth-secret", help="existing password secret (default NAME-auth)")
    deploy_parser.add_argument("--github-secret", help="existing GitHub secret (default NAME-github)")
    deploy_parser.add_argument("--password-file", help="new 0600 password file for a new app")
    deploy_parser.add_argument("--no-keepalive", dest="keepalive", action="store_false",
                               help="throwaway deploys only: no scheduled wakeup")
    settings_parser.add_argument("--file", required=True, help="JSON: version 1, repoUrl, displayName, webExtraSecrets")
    settings_parser.add_argument("--replace", action="store_true", help="overwrite an existing record")
    options = parser.parse_args(argv)
    name = _name(options.name)
    options.explicit_volume = options.volume is not None
    options.volume = _name(options.volume or f"{name}-data")
    if options.command == "status":
        show(name, options.volume)
        return 0
    if options.command == "settings-save":
        record = settings_record(json.loads(Path(options.file).read_text()))
        if not any(row.get("name") == options.volume for row in _inventory("volume")):
            raise SystemExit(f"Missing existing Volume {options.volume}; no settings were saved.")
        secret_names = {row.get("name") for row in _inventory("secret")}
        missing = [item for item in record["webExtraSecrets"] if item not in secret_names]
        if missing:
            raise SystemExit(f"Missing existing web extra secrets: {', '.join(missing)}")
        _save_settings(options.volume, record, options.replace)
        print(f"Saved deployment settings on Volume {options.volume}; they apply on the next deploy.")
        return 0
    options.explicit_auth, options.explicit_github = options.auth_secret is not None, options.github_secret is not None
    options.auth_secret = _name(options.auth_secret or f"{name}-auth")
    options.github_secret = _name(options.github_secret or f"{name}-github")
    pin, repo = prepare(options)
    return start(options, pin, repo)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *args: sys.exit(143))
    sys.exit(main(sys.argv[1:]))
