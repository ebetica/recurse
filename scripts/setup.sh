#!/usr/bin/env bash
# Minimal, idempotent setup for running recurse locally.
#
#   gh repo clone ebetica/recurse && cd recurse && ./scripts/setup.sh
#
# It requires Bun on PATH, builds the frontend, and then tells you how to
# start local mode. It never touches your data or secrets.
set -euo pipefail

cd "$(dirname "$0")/.."

# 1. Validate the launch environment; the user's Bun runs the launcher,
# the server and the frontend build.
MIN_BUN_VERSION=1.4.0
require_bun() {
  local version major minor patch
  command -v bun >/dev/null 2>&1 || {
    echo "[recurse] error: Bun >= $MIN_BUN_VERSION is required; install it with: curl -fsSL https://bun.sh/install | bash" >&2
    return 127
  }
  version="$(bun --version 2>/dev/null || true)"
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "[recurse] error: Bun >= $MIN_BUN_VERSION is required; found ${version:-unknown}. Install it with: curl -fsSL https://bun.sh/install | bash" >&2
    return 2
  fi
  IFS=. read -r major minor patch <<< "$version"
  if (( major < 1 || (major == 1 && (minor < 4 || (minor == 4 && patch < 0))) )); then
    echo "[recurse] error: Bun >= $MIN_BUN_VERSION is required; found $version. Install it with: curl -fsSL https://bun.sh/install | bash" >&2
    return 2
  fi
}
require_bun
echo "bun: $(command -v bun)"

# 2. Build the TypeScript + lit frontend. Without a built web/dist, local mode
# 404s on /static/app.js.
echo "Building the frontend with 'bun run build'..."
bun src/launcher/dependencies.ts
bun run build

# ./recurse runs this setup step inline before launching, so it silences the
# closing "start with…" note (it's already starting).
if [ -n "${RECURSE_SETUP_QUIET:-}" ]; then
  exit 0
fi

cat <<'EOF'

Setup complete. Put agents on your repo with:

    ./recurse ~/code/proj                  # a local path or a git URL
    ./recurse                              # no argument: develop recurse itself

Then open http://127.0.0.1:8787

Notes:
  - The default src/local.ts supervisor watches the checkout's Git HEAD and
    redeploys committed generations. Restart ./recurse to build uncommitted
    source edits. --once has no supervisor.
  - Auth is open on loopback; set CHAT_AUTH_SALT / CHAT_AUTH_HASH for a password.
  - Agents run on the pi coding agent (the only backend), which runs on Bun;
    Node.js and npm are not needed. RTK 0.43.0+ is optional: when unavailable,
    ./recurse warns once and continues with ordinary Pi output. bun install
    puts pinned Pi and pi-fff in node_modules, Recurse's Pi extensions load
    from checkout source, and ./recurse keeps its small managed files under
    this checkout's .recurse directory, while provider credentials stay under RECURSE_HOME (default
    $XDG_CONFIG_HOME/recurse, or ~/.config/recurse when XDG is unset/relative).
    pi serves both Claude and Codex; sign in from the UI's Settings on first
    use. A private remote repo (and opening PRs) needs GITHUB_TOKEN; a local
    directory needs no token. Config can go in a .env file at the checkout root.
EOF
