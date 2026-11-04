"""Offline tests for Modal deployment with real git, processes and HTTP.

Run: python3 playground/modal/test_deploy.py. tests/modal.py stands in for the
Modal SDK and a shell script for the modal CLI; nothing reaches Modal."""
import ast
import asyncio
from datetime import datetime, timezone
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
ORIGIN_URL = "https://example.invalid/recurse.git"
FAKE_CLI = """#!/bin/sh
case "$1" in
  app) echo '[{"description": "demo", "state": "deployed"}]' ;;
  secret) echo '[{"name": "demo-auth"}, {"name": "demo-github"}]' ;;
  volume) echo '[{"name": "demo-data"}]' ;;
  deploy) echo "$* pin=$RECURSE_MODAL_PIN name=$CHAT_APP_NAME" >> "$FAKE_MODAL_ROOT/deploys"
          if [ "$2" = "--strategy" ]; then
            printf '%s\\n%s\\n' "$RECURSE_MODAL_APT_PACKAGES" "$RECURSE_MODAL_PIP_PACKAGES" >> "$FAKE_MODAL_ROOT/packages"
          fi
          echo "image built" ;;
esac
"""
RESIST = ("import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
          "print('ready', flush=True); time.sleep(60)")
DESCENDANT = f"""import signal, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", {RESIST!r}], stdout=subprocess.PIPE, text=True)
child.stdout.readline()
signal.signal(signal.SIGTERM, lambda *args: sys.exit(0))
print("ready", flush=True)
while True:
    time.sleep(1)
"""


class SignIn(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(401)
        self.send_header("Content-Length", "7")
        self.end_headers()
        self.wfile.write(b"Sign in")

    def log_message(self, *args):
        pass


class DeployTest(unittest.TestCase):
    def test_deploy_status_lock_takeover_and_failed_verification(self):
        root = Path(tempfile.mkdtemp(prefix="modal-test-"))
        self.addCleanup(shutil.rmtree, root)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SignIn)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}/"
        env = {**os.environ, "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_VALUE_0": ORIGIN_URL,
               "GIT_CONFIG_KEY_0": f"url.{(root / 'origin.git').as_uri()}.insteadOf"}

        def git(*args):
            return subprocess.run(["git", *args], cwd=root / "repo", env=env, check=True,
                                  capture_output=True, text=True).stdout.strip()
        (root / "repo/playground/modal").mkdir(parents=True)
        subprocess.run(["git", "init", "-q", "--bare", str(root / "origin.git")], check=True)
        shutil.copy(HERE / "deploy.py", root / "repo/playground/modal/deploy.py")
        (root / "repo/playground/modal/modal_app.py").write_text("app = None\n")
        git("init", "-q", "-b", "main")
        git("add", ".")
        git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Wrapper")
        git("remote", "add", "origin", ORIGIN_URL)
        git("push", "-q", "origin", "main")
        sha = git("rev-parse", "HEAD")
        state = root / "demo-data/data/deploy-state"
        state.mkdir(parents=True)
        (state / "settings.json").write_text(json.dumps(
            {"version": 1, "repoUrl": None, "displayName": "Demo", "webExtraSecrets": []}))
        (root / "bin").mkdir()
        (root / "bin/modal").write_text(FAKE_CLI)
        (root / "bin/modal").chmod(0o755)
        env.update(PATH=f"{root / 'bin'}:{env['PATH']}", PYTHONPATH=str(HERE / "tests"), PYTHONDONTWRITEBYTECODE="1",
                   FAKE_MODAL_ROOT=str(root), FAKE_MODAL_WEB_URL=url)
        tool = [sys.executable, str(root / "repo/playground/modal/deploy.py")]

        def deploy(served=sha):
            return subprocess.run([*tool, "deploy", "demo"], capture_output=True,
                                  text=True, env={**env, "FAKE_MODAL_SERVED_PIN": served})
        status_file = state / "status.json"
        first = deploy()
        self.assertEqual(first.returncode, 0, first.stderr)
        status = json.loads(status_file.read_text())
        self.assertEqual((status["result"], status["sha"], status["url"], status["lastSucceededSha"]),
                         ("succeeded", sha, url, sha))
        deploy_log = (root / "demo-data" / status["log"]).read_text()
        self.assertIn("image built", deploy_log)
        self.assertIn(f"GET {url} /api/relay/requests -> 401", deploy_log)
        shown = subprocess.run([*tool, "status", "demo"], capture_output=True, text=True, env=env).stdout
        for text in ('App demo: [{"description": "demo"', "Last deploy: succeeded", "image built"):
            self.assertIn(text, shown)
        self.assertEqual((root / "packages").read_text().splitlines(), ["[]", "[]"])
        record = {"version": 1, "repoUrl": ORIGIN_URL, "displayName": "Demo", "webExtraSecrets": [],
                  "aptPackages": ["ffmpeg", "librsvg2-bin", "libstdc++-12-dev", "python3.11"], "pipPackages": ["Pillow"]}
        settings_file = root / "settings.json"
        settings_file.write_text(json.dumps(record))
        save = [*tool, "settings-save", "demo", "--file", str(settings_file), "--replace"]
        saved = subprocess.run(save, capture_output=True, text=True, env=env)
        self.assertEqual(saved.returncode, 0, saved.stderr)
        self.assertEqual(json.loads((state / "settings.json").read_text()), record)
        for key, bad in (("aptPackages", ["ffmpeg;touch-pwned"]), ("aptPackages", ["-o"]),
                         ("aptPackages", ["git-"]), ("aptPackages", ["git+"]), ("aptPackages", ["git."]),
                         ("aptPackages", ["git..core"]),
                         ("pipPackages", ["pillow>=1"]), ("pipPackages", ["pkg$(id)"]),
                         ("pipPackages", ["a"] * 33), ("aptPackages", ["a" * 129]),
                         ("aptPackages", "ffmpeg")):
            settings_file.write_text(json.dumps({**record, key: bad}))
            rejected = subprocess.run(save, capture_output=True, text=True, env=env)
            self.assertNotEqual(rejected.returncode, 0, (key, bad))
            self.assertEqual(json.loads((state / "settings.json").read_text()), record)
        self.assertEqual(deploy().returncode, 0)
        package_lines = (root / "packages").read_text().splitlines()
        self.assertEqual([json.loads(line) for line in package_lines[-2:]],
                         [record["aptPackages"], record["pipPackages"]])
        image_script = ("import importlib.util,json; "
                        f"s=importlib.util.spec_from_file_location('wrapper', {str(HERE / 'modal_app.py')!r}); "
                        "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                        "print(json.dumps(m.image.layers))")
        image_env = {**env, "RECURSE_MODAL_APP": "demo", "RECURSE_MODAL_VOLUME": "demo-data",
                     "RECURSE_MODAL_PIN": sha, "RECURSE_MODAL_WEB_EXTRA_SECRETS": "[]",
                     "RECURSE_MODAL_APT_PACKAGES": json.dumps(record["aptPackages"]),
                     "RECURSE_MODAL_PIP_PACKAGES": json.dumps(record["pipPackages"])}
        built = subprocess.run([sys.executable, "-c", image_script], capture_output=True, text=True, env=image_env)
        self.assertEqual(built.returncode, 0, built.stderr)
        layers = json.loads(built.stdout)
        self.assertEqual(layers[-4:-2], [["apt_install", record["aptPackages"]],
                                        ["pip_install", record["pipPackages"]]])
        self.assertEqual([layer[0] for layer in layers[-5:]],
                         ["env", "apt_install", "pip_install", "run_commands", "env"])
        empty = subprocess.run([sys.executable, "-c", image_script], capture_output=True, text=True,
                               env={**image_env, "RECURSE_MODAL_APT_PACKAGES": "[]", "RECURSE_MODAL_PIP_PACKAGES": "[]"})
        self.assertEqual(empty.returncode, 0, empty.stderr)
        empty_layers = json.loads(empty.stdout)
        self.assertEqual(layers[:-4] + layers[-2:], empty_layers)
        invalid = subprocess.run([sys.executable, "-c", image_script], capture_output=True, text=True,
                                 env={**image_env, "RECURSE_MODAL_PIP_PACKAGES": '["pillow;id"]'})
        self.assertNotEqual(invalid.returncode, 0)
        for bad in ("git;id", "git-", "git+", "git.", "git..core"):
            invalid_apt = subprocess.run([sys.executable, "-c", image_script], capture_output=True, text=True,
                                         env={**image_env, "RECURSE_MODAL_APT_PACKAGES": json.dumps([bad])})
            self.assertNotEqual(invalid_apt.returncode, 0, bad)
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        status_file.write_text(json.dumps({**status, "result": "running", "heartbeatAt": now}))
        refused = deploy()
        self.assertEqual(refused.returncode, 1)
        self.assertIn("already running", refused.stderr)
        status_file.write_text(json.dumps({**status, "result": "running", "heartbeatAt": "2026-01-01T00:00:00Z"}))
        self.assertEqual(deploy("0" * 40).returncode, 1)
        failed = json.loads(status_file.read_text())
        self.assertEqual((failed["result"], failed["lastSucceededSha"]), ("failed", sha))
        self.assertIn(f"deployed commit {'0' * 40} is not {sha}", failed["error"])
        wrappers = [line for line in (root / "deploys").read_text().splitlines()
                    if line.startswith("deploy --strategy recreate")]
        self.assertEqual(len(wrappers), 3)
        self.assertTrue(wrappers[0].endswith(f"modal_app.py pin={sha} name=Demo"), wrappers[0])

    def test_forced_web_cleanup_never_commits_the_volume(self):
        tree = ast.parse((HERE / "modal_app.py").read_text())
        stop_web = next(node for node in tree.body if getattr(node, "name", "") == "_stop_web")
        web = next(node for node in tree.body if getattr(node, "name", "") == "Web")
        web.decorator_list = []
        web.body = [node for node in web.body if getattr(node, "name", "") == "stop"]
        web.body[0].decorator_list = []
        commits = []

        async def commit():
            commits.append(True)
        namespace = dict(asyncio=asyncio, os=os, signal=signal, time=time,
                         volume=SimpleNamespace(commit=SimpleNamespace(aio=commit)))
        exec(compile(ast.Module(body=[stop_web, web], type_ignores=[]), "modal_app.py", "exec"), namespace)
        for code, error in ((RESIST, "did not exit cleanly"), (DESCENDANT, "Forced group cleanup")):
            child = subprocess.Popen([sys.executable, "-c", code], start_new_session=True,
                                     stdout=subprocess.PIPE, text=True)
            self.assertEqual(child.stdout.readline().strip(), "ready")
            if code == RESIST:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            instance = namespace["Web"]()
            instance.child = child
            with self.assertRaisesRegex(RuntimeError, error):
                asyncio.run(instance.stop())
            child.stdout.close()
            self.assertEqual(commits, [])
            with self.assertRaises(ProcessLookupError):
                os.killpg(child.pid, 0)

    def test_sleep_check_answers_each_home_from_the_exit_hook_state(self):
        root = Path(tempfile.mkdtemp(prefix="modal-sleep-"))
        self.addCleanup(shutil.rmtree, root)
        check_url = "https://demo--demo-sleep-check.example.invalid"
        env = {"RECURSE_MODAL_APP": "demo", "RECURSE_MODAL_PIN": "a" * 40, "FAKE_MODAL_ROOT": str(root),
               "FAKE_MODAL_WEB_URL": check_url}
        environment = mock.patch.dict(os.environ, env)
        environment.start()
        self.addCleanup(environment.stop)
        with mock.patch.dict(sys.modules), mock.patch.object(sys, "path", [str(HERE / "tests"), *sys.path]):
            sys.modules.pop("modal", None)
            spec = importlib.util.spec_from_file_location("wrapper", HERE / "modal_app.py")
            wrapper = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(wrapper)
        laptop, home = "1" * 16, "2" * 16
        secret = {laptop: "a" * 64, home: "b" * 64}
        data = root / "data"
        data.mkdir()
        (data / "backend-keys.json").write_text(json.dumps([
            {"id": key, "name": name, "created": 1, "last_used": None,
             "sha256": hashlib.sha256(secret[key].encode()).hexdigest()}
            for key, name in ((laptop, "Laptop"), (home, "Home"))]))
        (data / "relay-queue.json").write_text(json.dumps({
            "labels": {"Laptop": {"name": "Laptop", "key": laptop}, "Home": {"name": "Home", "key": home},
                       "Phone": {"name": "Phone", "key": None}},
            "requests": [{"id": "m1", "agent": "a1", "label": "Laptop", "sender": "s1", "title": None,
                          "content": "private words", "interrupt": False}]}))

        async def commit():
            pass
        bun = root / "bun"
        bun.write_text(f"#!{sys.executable}\n"
                       "import json, os, signal, sys, time\n"
                       "signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))\n"
                       "open(sys.argv[0] + '.tmp', 'w').write(json.dumps(dict(os.environ)))\n"
                       "os.replace(sys.argv[0] + '.tmp', sys.argv[0] + '.env')\n"
                       "while True: time.sleep(1)\n")
        bun.chmod(0o755)
        wrapper.BUN, wrapper.SNAPSHOT, wrapper.DATA_DIR = str(bun), str(root), str(data)
        wrapper.volume = SimpleNamespace(reload=lambda: None, commit=SimpleNamespace(aio=commit))
        web = wrapper.Web()
        web.web()
        deadline = time.monotonic() + 30
        while not Path(f"{bun}.env").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        started = json.loads(Path(f"{bun}.env").read_text())
        self.assertEqual((started["RECURSE_SLEEP_CHECK_URL"], started["RECURSE_SLEEP_WHEN_IDLE"]), (check_url, "1"))
        self.assertEqual(wrapper.sleep_dict.get("awake"), web.sleep_token)
        asyncio.run(web.stop())
        self.assertEqual(wrapper.sleep_dict.get("asleep")["token"], web.sleep_token)
        self.assertNotIn("private words", json.dumps(wrapper.sleep_dict.data))
        app = wrapper.sleep_check()

        def call(authorization=None, path="/api/relay/requests"):
            sent = []

            async def send(message):
                sent.append(message)
            headers = [(b"authorization", authorization.encode())] if authorization else []
            asyncio.run(app({"type": "http", "method": "GET", "path": path, "headers": headers}, None, send))
            return sent[0]["status"], json.loads(sent[1]["body"])

        def key(key_id, secret_of=None):
            return f"Bearer recurse-link_{key_id}_{secret[secret_of or key_id]}"
        asleep = (200, {"requests": [], "sleep_seconds": 3600})
        wake = (200, {"requests": []})
        self.assertEqual(call(key(home)), asleep)
        self.assertEqual(call(key(laptop)), wake)
        for refused in (key(home, laptop), key("3" * 16, home), None, key(home)[:-1], "Basic " + key(home)[7:]):
            self.assertEqual(call(refused)[0], 401, refused)
        self.assertEqual(call(key(home), "/api/tree")[0], 404)
        wrapper.sleep_dict.put("awake", "newer container")
        self.assertEqual(call(key(home)), wake)

        async def unavailable(*args):
            raise ConnectionError("dict down")
        wrapper.sleep_dict = SimpleNamespace(get=SimpleNamespace(aio=unavailable))
        self.assertEqual((call(key(home))[0], call(None)[0]), (503, 401))
        (data / "relay-queue.json").write_text("{")
        self.assertIsNone(wrapper.sleep_state_for(data))

        events = iter([{"type": "lifespan.startup"}, {"type": "lifespan.shutdown"}])
        sent = []

        async def receive():
            return next(events)

        async def send(message):
            sent.append(message["type"])
        asyncio.run(app({"type": "lifespan"}, receive, send))
        self.assertEqual(sent, ["lifespan.startup.complete", "lifespan.shutdown.complete"])


if __name__ == "__main__":
    unittest.main()
