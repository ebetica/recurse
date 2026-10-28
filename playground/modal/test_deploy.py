"""Offline tests for Modal deployment with real git, processes and HTTP.

Run: python3 playground/modal/test_deploy.py. tests/modal.py stands in for the
Modal SDK and a shell script for the modal CLI; nothing reaches Modal."""
import ast
import asyncio
from datetime import datetime, timezone
import http.server
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

HERE = Path(__file__).resolve().parent
ORIGIN_URL = "https://example.invalid/recurse.git"
FAKE_CLI = """#!/bin/sh
case "$1" in
  app) echo '[{"description": "demo", "state": "deployed"}]' ;;
  secret) echo '[{"name": "demo-auth"}, {"name": "demo-github"}]' ;;
  volume) echo '[{"name": "demo-data"}]' ;;
  deploy) echo "$* pin=$RECURSE_MODAL_PIN name=$CHAT_APP_NAME" >> "$FAKE_MODAL_ROOT/deploys"
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
        self.assertIn("image built", (root / "demo-data" / status["log"]).read_text())
        shown = subprocess.run([*tool, "status", "demo"], capture_output=True, text=True, env=env).stdout
        for text in ('App demo: [{"description": "demo"', "Last deploy: succeeded", "image built"):
            self.assertIn(text, shown)
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
        self.assertEqual(len(wrappers), 2)
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


if __name__ == "__main__":
    unittest.main()
