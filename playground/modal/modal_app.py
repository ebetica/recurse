"""Build the pinned Modal image and run Bun with one web supervisor.

Secrets and the Volume must already exist; image builds never change data.
deploy.py (beside it) deploys this file with `--strategy recreate`. On exit the
web container stops Bun's whole process group before committing the Volume."""

import asyncio
import base64
import json
from itertools import islice
import os
import re
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
    .run_commands(_TOOL_BUILD, secrets=GITHUB_SECRET)
    .env(
        {
            "RECURSE_TEMP_IN_DATA_DIR": "1",
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
    )
)

app = modal.App(APP_NAME)
volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=False)

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
        self.child = subprocess.Popen(
            [BUN, f"{SNAPSHOT}/src/local.ts", "--prebuilt"],
            cwd=SNAPSHOT, env=_env(), start_new_session=True)

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
                return f"pending intent ({db.stem})"
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
                return "detached shell running"
    return None

def _durable_work(conversations: Path) -> str | None:
    """Find recent Durable database writes or live shell records."""
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
            for name in ("session.sqlite", "session.sqlite-wal"):
                session = durable / name
                try:
                    if (
                        not session.is_symlink()
                        and session.is_file()
                        and now - session.stat().st_mtime <= _WARM_TURN_MAX_AGE_SECONDS
                    ):
                        return "durable session active"
                except OSError:
                    continue
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
