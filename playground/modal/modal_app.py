"""Build the pinned Modal image and run Bun with one web supervisor.

Secrets and the Volume must already exist; image builds never change data.
deploy.py (beside it) deploys this file with `--strategy recreate`. On exit the
web container stops Bun's whole process group before committing the Volume.
`sleep_check` answers sleeping homes' hourly check-ins from a Dict, without
starting the web container."""

import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import json
from itertools import islice
import os
import re
import secrets
import shlex
import signal
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import modal

APP_NAME = os.environ["RECURSE_MODAL_APP"]
VOLUME_NAME = os.environ.get("RECURSE_MODAL_VOLUME", f"{APP_NAME}-data")
if VOLUME_NAME != f"{APP_NAME}-data" and os.environ.get(
    "RECURSE_MODAL_CONFIRMED_VOLUME"
) != VOLUME_NAME:
    raise SystemExit("refusing mismatched Volume; use deploy.py deploy --volume")
AUTH_SECRET = os.environ.get("RECURSE_MODAL_AUTH_SECRET", f"{APP_NAME}-auth")
GITHUB_SECRET_NAME = os.environ.get("RECURSE_MODAL_GITHUB_SECRET", f"{APP_NAME}-github")
APP_REPO_URL = os.environ.get(
    "RECURSE_MODAL_REPO_URL", "https://github.com/ebetica/recurse.git"
)
PORT = 8000

BUN_VERSION = "1.4.2"
BUN_SHA256 = "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913"
RTK_VERSION = "0.43.0"
RTK_SHA256 = "ff8a1e7766496e175291a85aeca1dc97c9ff6df33e51e5893d1fbc78fea2a609"
GH_VERSION = "2.63.2"
GH_SHA256 = "912fdb1ca29cb005fb746fc5d2b787a289078923a29d0f9ec19a0b00272ded00"
PLAYWRIGHT_VERSION = "1.61.0"
MODAL_VERSION = "1.5.1"

VOL = "/vol"
VOL_ROOT = os.path.realpath(VOL)
DATA_DIR = f"{VOL_ROOT}/data"
STATE_HOME = f"{VOL_ROOT}/state"

HOME = "/root"
BIN_DIR = "/opt/bin"
BUN = f"{BIN_DIR}/bun"
SNAPSHOT = "/opt/recurse-src"
_PATH = ":".join(
    [
        BIN_DIR,
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
)

IMAGE_PIN = os.environ["RECURSE_MODAL_PIN"]
if len(IMAGE_PIN) != 40 or any(c not in "0123456789abcdef" for c in IMAGE_PIN):
    raise SystemExit("RECURSE_MODAL_PIN must be an exact 40-hex commit")


def _env(extra: dict | None = None) -> dict:
    """Runtime roots, applied after Modal mounts the Volume."""
    env = dict(os.environ)
    env.update(
        {
            "HOME": HOME,
            "XDG_CONFIG_HOME": f"{HOME}/.config",
            "XDG_CACHE_HOME": f"{HOME}/.cache",
            "PATH": _PATH,
            "RECURSE_HOME": STATE_HOME,
            "RECURSE_BROWSER_VERSION": IMAGE_PIN,
            "CHAT_DATA_DIR": DATA_DIR,
            "HOST": "0.0.0.0",
            "PORT": str(PORT),
            "RECURSE_SELF_DEPLOY": "0",
            "IS_SANDBOX": "1",
            "RTK_TELEMETRY_DISABLED": "1",
            "RTK_NO_TOML": "1",
        }
    )
    env.pop("RECURSE_CODE_HOME", None)
    env.update(extra or {})
    return env

GITHUB_SECRET = [modal.Secret.from_name(GITHUB_SECRET_NAME, required_keys=["GITHUB_TOKEN"])]
SECRETS = [modal.Secret.from_name(AUTH_SECRET, required_keys=["CHAT_AUTH_SALT", "CHAT_AUTH_HASH"])] + GITHUB_SECRET
def _web_extra_secret_names() -> list[str]:
    """Validate explicit web-only bindings; never invent or create secrets."""
    names = json.loads(os.environ.get("RECURSE_MODAL_WEB_EXTRA_SECRETS", "[]"))
    if (
        not isinstance(names, list)
        or len(names) > 32
        or any(not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}", name) for name in names)
        or len(names) != len(set(names))
    ):
        raise SystemExit("web extra secrets must be a list of distinct existing secret names")
    return names

WEB_SECRETS = SECRETS + [modal.Secret.from_name(name) for name in _web_extra_secret_names()]
_ARTIFACT_MANIFEST = f"{SNAPSHOT}/.recurse/modal-artifacts.json"

_TOOL_SCRIPT = r"""
set -euo pipefail
git -c "credential.helper=$CRED_HELPER" clone "$APP_REPO_URL" "$SNAPSHOT"
git -C "$SNAPSHOT" config credential.https://github.com.helper "$CRED_HELPER"
git -C "$SNAPSHOT" checkout --detach "$IMAGE_PIN"
cd "$SNAPSHOT"

export RECURSE_HOME=/tmp/recurse-build-home
unset PI_CODING_AGENT_DIR
mkdir -p "$RECURSE_HOME"
bun src/launch_cli.ts build "$SNAPSHOT"
bun src/launch_cli.ts build-stamp check "$SNAPSHOT"
rm -rf "$RECURSE_HOME"

bun src/local.ts --help | grep -q -- '--prebuilt'
bun -e 'import { PREBUILT_ARTIFACTS } from "./src/local.ts";
const artifacts = ["src/local.ts", ...PREBUILT_ARTIFACTS, ".recurse/.build-stamp.json"];
await Bun.write(".recurse/modal-artifacts.json", JSON.stringify(artifacts));
for (const artifact of artifacts) {
if (!(await Bun.file(artifact).exists())) throw new Error(`Missing artifact: ${artifact}`);
}'
"""

_CRED_HELPER = (
    '!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f'
)
_TOOL_BUILD = " ".join(
    [
        f"echo {base64.b64encode(_TOOL_SCRIPT.encode()).decode()}",
        "| base64 -d > /tmp/build-tools.sh &&",
        f"APP_REPO_URL={shlex.quote(APP_REPO_URL)}",
        f"SNAPSHOT={SNAPSHOT}",
        f"IMAGE_PIN={shlex.quote(IMAGE_PIN)}",
        f"CRED_HELPER={shlex.quote(_CRED_HELPER)}",
        "bash /tmp/build-tools.sh",
    ]
)

def _packages(variable: str, pattern: str) -> list[str]:
    """Accept only bounded lists of plain package names from deploy settings."""
    names = json.loads(os.environ.get(variable, "[]"))
    if (not isinstance(names, list) or len(names) > 32
            or any(not isinstance(name, str) or not re.fullmatch(pattern, name)
                   or (variable == "RECURSE_MODAL_APT_PACKAGES" and ".." in name) for name in names)
            or len(names) != len(set(names))):
        raise SystemExit(f"{variable} must contain at most 32 distinct plain package names")
    return names


apt_packages = _packages("RECURSE_MODAL_APT_PACKAGES", r"[a-z0-9](?:[a-z0-9+.-]{0,126}[a-z0-9])?")
pip_packages = _packages("RECURSE_MODAL_PIP_PACKAGES", r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install(
        "git",
        "curl",
        "ca-certificates",
        "unzip",
        "ripgrep",
        "procps",
        "less",
        "openssh-client",
    )
    .run_commands(
        f"mkdir -p {BIN_DIR} && cd /tmp"
        f" && curl -fsSLO https://github.com/oven-sh/bun/releases/download/"
        f"bun-v{BUN_VERSION}/bun-linux-x64.zip"
        f" && curl -fsSLO https://github.com/oven-sh/bun/releases/download/"
        f"bun-v{BUN_VERSION}/SHASUMS256.txt"
        f" && grep -qx '{BUN_SHA256}  bun-linux-x64.zip' SHASUMS256.txt"
        f" && echo '{BUN_SHA256}  bun-linux-x64.zip' | sha256sum -c -"
        f" && unzip -q bun-linux-x64.zip && install -m755 bun-linux-x64/bun {BUN}"
        f" && ln -s bun {BIN_DIR}/bunx"
        " && rm -rf bun-linux-x64.zip bun-linux-x64 SHASUMS256.txt"
        f" && {BUN} --version",
        f"curl -fsSL https://github.com/rtk-ai/rtk/releases/download/"
        f"v{RTK_VERSION}/rtk-x86_64-unknown-linux-musl.tar.gz -o /tmp/rtk.tgz"
        f" && echo '{RTK_SHA256}  /tmp/rtk.tgz' | sha256sum -c -"
        f" && tar xzf /tmp/rtk.tgz -C {BIN_DIR} rtk"
        f" && {BIN_DIR}/rtk --version"
        " || echo '[image] rtk unavailable; continuing without it'",
    )
    .run_commands(
        f"curl -fsSL https://github.com/cli/cli/releases/download/"
        f"v{GH_VERSION}/gh_{GH_VERSION}_linux_amd64.tar.gz -o /tmp/gh.tgz"
        f" && echo '{GH_SHA256}  /tmp/gh.tgz' | sha256sum -c -"
        " && tar xzf /tmp/gh.tgz -C /usr/local --strip-components=1"
        " && rm /tmp/gh.tgz && gh --version",
        f"cd /tmp && HOME={HOME} {BUN} x --bun playwright@{PLAYWRIGHT_VERSION}"
        " install --with-deps chromium webkit",
        f"pip install --no-cache-dir modal=={MODAL_VERSION} && modal --version",
    )
    .env(
        {
            "PATH": _PATH,
            "RTK_TELEMETRY_DISABLED": "1",
            "RTK_NO_TOML": "1",
        }
    )
)
if apt_packages:
    image = image.apt_install(*apt_packages)
if pip_packages:
    image = image.pip_install(*pip_packages)

# What importing this file inside a container needs.
_WRAPPER_ENV = {
    "RECURSE_MODAL_PIN": IMAGE_PIN,
    "RECURSE_MODAL_IMAGE_PIN": IMAGE_PIN,
    "RECURSE_MODAL_APP": APP_NAME,
    "RECURSE_MODAL_VOLUME": VOLUME_NAME,
    "RECURSE_MODAL_AUTH_SECRET": AUTH_SECRET,
    "RECURSE_MODAL_GITHUB_SECRET": GITHUB_SECRET_NAME,
    "RECURSE_MODAL_CONFIRMED_VOLUME": VOLUME_NAME,
    "RECURSE_MODAL_REPO_URL": APP_REPO_URL,
    "RECURSE_MODAL_WEB_EXTRA_SECRETS": json.dumps(_web_extra_secret_names()),
    **{key: os.environ[key] for key in ("CHAT_REPO_URL", "CHAT_APP_NAME") if key in os.environ},
}
image = (
    image.run_commands(_TOOL_BUILD, secrets=GITHUB_SECRET)
    .env({"RECURSE_TEMP_IN_DATA_DIR": "1", **_WRAPPER_ENV})
)
# The check-in needs no tools, Volume or secrets: only this file and the Dict.
sleep_check_image = modal.Image.debian_slim(python_version="3.12").env(_WRAPPER_ENV)

app = modal.App(APP_NAME)
volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=False)
# "awake": the running web container's token; "asleep": what its exit hook
# saw, {"token", "keys": {key id: {"sha256", "waiting"}}}. No message content.
sleep_dict = modal.Dict.from_name(f"{APP_NAME}-sleep-check", create_if_missing=True)
SLEEP_CHECK_SECONDS = 3600
_MAX_SLEEP_KEYS = 1000

_PI_CLI = f"{SNAPSHOT}/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
_CHROMIUM_CHECK = (
    "import { chromium } from 'playwright';"
    " const b = await chromium.launch(); await b.close();"
)
_WEBKIT_CHECK = (
    "import { webkit } from 'playwright';"
    " const b = await webkit.launch(); await b.close();"
)
_SELFTEST_TOOLS = [
    ("bun", [BUN, "--version"]),
    ("bunx", [f"{BIN_DIR}/bunx", "--version"]),
    ("pi cli", [BUN, _PI_CLI, "--version"]),
    ("gh", ["gh", "--version"]),
    ("rg", ["rg", "--version"]),
    ("rtk", ["rtk", "--version"]),
    ("git", ["git", "--version"]),
    ("modal", ["modal", "--version"]),
    ("chromium", [BUN, "-e", _CHROMIUM_CHECK]),
    ("webkit", [BUN, "-e", _WEBKIT_CHECK]),
]

def _verify_tools() -> dict:
    """Check installed tools and report the deployed source and resources."""
    env = _env({"PI_CODING_AGENT_DIR": f"{STATE_HOME}/pi-agent"})
    for tool, argv in _SELFTEST_TOOLS:
        try:
            got = subprocess.run(
                argv,
                cwd=SNAPSHOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=180,
            )
        except FileNotFoundError:
            got = None
        if tool == "rtk" and (got is None or got.returncode != 0):
            print("[selftest] optional rtk unavailable")
            continue
        if got is None:
            raise RuntimeError(f"{tool} is missing from the image")
        line = (got.stdout or got.stderr).strip().splitlines() or [""]
        print(
            f"[selftest] {'OK  ' if got.returncode == 0 else 'FAIL'} {tool}: "
            f"{line[0][:80]}"
        )
        if got.returncode != 0:
            raise RuntimeError(f"{tool} is missing from the image")

    return {"app": APP_NAME, "volume": VOLUME_NAME, "image_pin": IMAGE_PIN,
            "auth_secret": AUTH_SECRET, "github_secret": GITHUB_SECRET_NAME}

@app.function(
    image=image,
    volumes={VOL: volume},
    secrets=SECRETS,
    timeout=900,
    cpu=4.0,
    memory=8192,
)
def verify() -> dict:
    """Check the image's tools and report the deployed commit and resources."""
    return _verify_tools()

@app.function(image=image, volumes={VOL: volume}, timeout=300, cpu=0.25)
def status() -> dict:
    """Cheap resource, artifact and background-work diagnostics; no secrets."""
    volume.reload()
    artifacts = json.loads(Path(_ARTIFACT_MANIFEST).read_text())
    return {
        "app": os.environ.get("RECURSE_MODAL_APP", "?"),
        "volume": os.environ.get("RECURSE_MODAL_VOLUME", "?"),
        "display_name": os.environ.get("CHAT_APP_NAME", "(default)"),
        "auth_secret": os.environ.get("RECURSE_MODAL_AUTH_SECRET", "?"),
        "image_pin": os.environ.get("RECURSE_MODAL_IMAGE_PIN", "?"),
        "artifacts": {
            "bun": Path(BUN).is_file(),
            **{name: Path(SNAPSHOT, name).is_file() for name in artifacts},
        },
        "warm": _warm_reason(),
    }

def _start_sleep_check(token: str) -> str:
    """Mark this container awake in the Dict; return the check-in's URL."""
    sleep_dict.put("awake", token)
    return modal.Function.from_name(APP_NAME, "sleep_check").get_web_url()


def _stop_web(child) -> bool:
    """Wait for process group exit; return false if a forced kill was needed."""
    for termination, seconds in ((signal.SIGTERM, 15), (signal.SIGKILL, 3)):
        try:
            os.killpg(child.pid, termination)
        except ProcessLookupError:
            child.wait(timeout=0)
            return True
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            child.poll()
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                child.wait(timeout=0)
                return termination == signal.SIGTERM
            time.sleep(0.01)
    raise RuntimeError("Web process group survived shutdown")


@app.cls(
    image=image,
    volumes={VOL: volume},
    secrets=WEB_SECRETS,
    max_containers=1,
    scaledown_window=600,
    timeout=3600,
    cpu=(0.5, 16),
    memory=500,
)
@modal.concurrent(max_inputs=64)
class Web:
    @modal.web_server(PORT, startup_timeout=300, label=f"{APP_NAME}-web")
    def web(self) -> None:
        """Start Bun in its own process group on the latest committed Volume."""
        volume.reload()
        print(f"[web] supervisor start pin={IMAGE_PIN} time={time.time()}", flush=True)
        extra = {"RECURSE_SLEEP_WHEN_IDLE": "1"}
        self.sleep_token = secrets.token_hex(16)
        pool = ThreadPoolExecutor(1)
        try:
            # Before Bun starts, so check-ins send homes here while it runs.
            extra["RECURSE_SLEEP_CHECK_URL"] = pool.submit(
                _start_sleep_check, self.sleep_token).result(timeout=5)
        except Exception as exc:
            print(f"[web] sleep check-in unavailable: {exc!r}", flush=True)
        finally:
            pool.shutdown(wait=False)
        self.child = subprocess.Popen(
            [BUN, f"{SNAPSHOT}/src/local.ts", "--prebuilt"],
            cwd=SNAPSHOT, env=_env(extra), start_new_session=True)

    @modal.exit()
    async def stop(self) -> None:
        """Commit the Volume only after Bun's process group exits cleanly."""
        child = getattr(self, "child", None)
        if not child:
            return
        if not await asyncio.to_thread(_stop_web, child):
            raise RuntimeError("Forced group cleanup; Volume not committed")
        if child.returncode != 0:
            raise RuntimeError("Bun did not exit cleanly; Volume not committed")
        await asyncio.wait_for(volume.commit.aio(), timeout=8)
        print("[web] process group stopped; Volume commit complete", flush=True)
        keys = sleep_state_for(DATA_DIR)
        if keys is not None and getattr(self, "sleep_token", None):
            try:
                await asyncio.wait_for(sleep_dict.put.aio(
                    "asleep", {"token": self.sleep_token, "keys": keys}), timeout=3)
            except Exception as exc:
                print(f"[web] sleep check-in state not saved: {exc!r}", flush=True)

_WARM_TURN_MAX_AGE_SECONDS = 15 * 60
_SCAN_CAP = 2000
_MAX_AGENT_DBS = 500
_MAX_SHELL_RECORDS = 500
_MAX_RECORD_BYTES = 64 * 1024

def _pending_intents(agents: Path) -> str | None:
    """Return a reason to stay warm when an agent has unfinished work."""
    try:
        dbs = list(islice(agents.glob("*.sqlite"), _MAX_AGENT_DBS + 1))
        if len(dbs) > _MAX_AGENT_DBS:
            return "agent scan capacity exceeded"
    except OSError:
        return None
    for db in dbs:
        if db.name.startswith("."):
            continue
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        except Exception:
            continue
        try:
            try:
                row = conn.execute("SELECT 1 FROM intents LIMIT 1").fetchone()
            except Exception:
                continue
            if row is not None:
                return f"pending intent: {db}"
        finally:
            try:
                conn.close()
            except Exception:
                pass
    return None

def _running_shell(state: Path) -> str | None:
    """Find a fresh running-shell record, skipping invalid or unsafe files."""
    now = time.time()
    checked = 0
    try:
        if state.is_symlink():
            return None
        sessions = list(islice(state.iterdir(), _SCAN_CAP + 1))
        if len(sessions) > _SCAN_CAP:
            return "shell session scan capacity exceeded"
    except OSError:
        return None
    for session_index, session in enumerate(sessions):
        if session_index >= _SCAN_CAP:
            break
        if session.name.startswith("."):
            continue
        try:
            if session.is_symlink():
                continue
            if session.is_file():
                records = [session]
            elif session.is_dir():
                records = list(islice(session.iterdir(), _MAX_SHELL_RECORDS + 1))
            else:
                continue
            if len(records) > _MAX_SHELL_RECORDS:
                return "shell record scan capacity exceeded"
        except OSError:
            continue
        for record in records:
            if checked >= _MAX_SHELL_RECORDS:
                return "shell scan capacity exceeded"
            if not record.name.endswith(".json"):
                continue
            checked += 1
            try:
                if record.is_symlink():
                    continue
                info = record.stat()
                if (
                    info.st_size > _MAX_RECORD_BYTES
                    or now - info.st_mtime > _WARM_TURN_MAX_AGE_SECONDS
                ):
                    continue
                with open(record, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
            except (OSError, ValueError):
                continue
            if isinstance(data, dict) and data.get("status") == "running":
                return f"detached shell running: {record}"
    return None

def _durable_work(conversations: Path) -> str | None:
    """Find fresh Durable work markers or live shell records."""
    now = time.time()
    try:
        if conversations.is_symlink():
            return None
        for index, conversation in enumerate(conversations.iterdir()):
            if index >= _SCAN_CAP:
                return "conversation scan capacity exceeded"
            if conversation.name.startswith(".") or conversation.is_symlink():
                continue
            durable = conversation / "durable"
            if durable.is_symlink():
                continue
            activity = durable / "activity"
            try:
                if (
                    not activity.is_symlink()
                    and activity.is_file()
                    and now - activity.stat().st_mtime <= _WARM_TURN_MAX_AGE_SECONDS
                ):
                    return f"durable work active: {activity}"
            except OSError:
                pass
            shells = durable / "shells"
            if not shells.is_symlink() and (reason := _running_shell(shells)):
                return reason
    except OSError:
        return None
    return None

def warm_reason_for(data_dir: str | Path) -> str | None:
    """Return why this data directory needs a warm container, or None."""
    root = Path(data_dir)
    for probe in (
        _durable_work(root / "conversations"),
        _pending_intents(root / "agents"),
        _running_shell(Path(os.environ.get("PI_BG_SHELL_STATE_DIR", str(root / "pi_bg_shell_state")))),
    ):
        if probe is not None:
            return probe
    return None

def _warm_reason() -> str | None:
    """The live decision: `warm_reason_for` over the Volume's data dir."""
    return warm_reason_for(DATA_DIR)

@app.function(
    image=image,
    volumes={VOL: volume},
    schedule=(
        None if os.environ.get("RECURSE_MODAL_KEEPALIVE") == "0"
        else modal.Period(minutes=1)
    ),
    timeout=120,
    scaledown_window=2,
    cpu=0.125,
    memory=256,
)
def keepalive() -> str | None:
    """Keep the web container warm with HTTP requests while work remains."""
    volume.reload()
    reason = _warm_reason()
    if not reason:
        return None
    try:
        target = modal.Cls.from_name(APP_NAME, "Web")().web
        url = target.get_web_url()
    except Exception as exc:
        print(f"[keepalive] cannot resolve the web URL: {exc}")
        return None
    request = urllib.request.Request(
        url, method="GET", headers={"User-Agent": "recurse-keepalive"}
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            code = response.status
    except urllib.error.HTTPError as exc:
        code = exc.code
    except Exception as exc:
        print(f"[keepalive] poke failed ({reason}): {exc}")
        return reason
    print(f"[keepalive] poked {url} ({code}) because {reason}")
    return reason


_HEX16 = re.compile(r"[a-f0-9]{16}")
_HEX64 = re.compile(r"[a-f0-9]{64}")
_KEY = re.compile(r"Bearer recurse-link_([a-f0-9]{16})_([a-f0-9]{64})")


def _json_file(path: Path, missing):
    """Parsed JSON, `missing` if the file is absent, None if unreadable."""
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return missing
    except (OSError, ValueError):
        return None


def sleep_state_for(data_dir: str | Path) -> dict | None:
    """Per backend key: its stored digest and whether Recurse queued relay
    messages for the home using it (relay-queue.json routes labels to keys).
    None if a file is unreadable or holds more than _MAX_SLEEP_KEYS keys."""
    root = Path(data_dir)
    keys = _json_file(root / "backend-keys.json", [])
    queue = _json_file(root / "relay-queue.json", {"labels": {}, "requests": []})
    if (not isinstance(keys, list) or len(keys) > _MAX_SLEEP_KEYS or not isinstance(queue, dict)
            or not isinstance(queue.get("labels"), dict) or not isinstance(queue.get("requests"), list)):
        return None
    routes = {label: route.get("key") for label, route in queue["labels"].items() if isinstance(route, dict)}
    waiting = {routes.get(request.get("label")) for request in queue["requests"]
               if isinstance(request, dict) and isinstance(request.get("label"), str)}
    state = {}
    for key in keys:
        if (not isinstance(key, dict) or not isinstance(key.get("id"), str) or not isinstance(key.get("sha256"), str)
                or not _HEX16.fullmatch(key["id"]) or not _HEX64.fullmatch(key["sha256"])):
            return None
        state[key["id"]] = {"sha256": key["sha256"], "waiting": key["id"] in waiting}
    return state


def sleep_check_answer(authorization: str, awake, asleep) -> tuple[int, dict]:
    """401 unless `authorization` is a backend key whose digest matches; then
    keep sleeping only if the web container stopped after the last start and
    nothing is queued for that key. Reveals nothing about other keys."""
    match = _KEY.fullmatch(authorization or "")
    if match and (not isinstance(awake, str) or not isinstance(asleep, dict) or asleep.get("token") != awake):
        return 503, {"detail": "web container may be awake"}
    keys = asleep.get("keys") if isinstance(asleep, dict) else None
    record = keys.get(match[1]) if match and isinstance(keys, dict) else None
    expected = record.get("sha256") if isinstance(record, dict) else None
    candidate = hashlib.sha256(match[2].encode()).hexdigest() if match else ""
    if not hmac.compare_digest(candidate, expected if isinstance(expected, str) else "0" * 64) or not expected:
        return 401, {"detail": "backend key required"}
    if record.get("waiting") is not False:
        return 200, {"requests": []}
    return 200, {"requests": [], "sleep_seconds": SLEEP_CHECK_SECONDS}


async def sleep_check_asgi(scope, receive, send) -> None:
    """GET /api/relay/requests answered from the Dict; anything else is 404."""
    if scope["type"] == "lifespan":
        while (await receive())["type"] == "lifespan.startup":
            await send({"type": "lifespan.startup.complete"})
        await send({"type": "lifespan.shutdown.complete"})
        return
    status, body = 404, {"detail": "not found"}
    if scope.get("method") == "GET" and scope.get("path") == "/api/relay/requests":
        authorization = dict(scope.get("headers", [])).get(b"authorization", b"").decode("latin-1")
        status, body = 401, {"detail": "backend key required"}
        try:
            if _KEY.fullmatch(authorization):
                awake = await sleep_dict.get.aio("awake")
                asleep = await sleep_dict.get.aio("asleep")
                status, body = sleep_check_answer(authorization, awake, asleep)
        except Exception:
            status, body = 503, {"detail": "check-in unavailable"}
    payload = json.dumps(body).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(payload)).encode())]})
    await send({"type": "http.response.body", "body": payload})


@app.function(image=sleep_check_image, cpu=0.125, memory=256, scaledown_window=2,
              min_containers=0, timeout=30)
@modal.concurrent(max_inputs=100)
@modal.asgi_app(label=f"{APP_NAME}-sleep-check")
def sleep_check():
    """Answer a sleeping home's check-in without starting the web container."""
    return sleep_check_asgi
