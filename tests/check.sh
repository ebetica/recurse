#!/usr/bin/env bash
# The one definition of the CI-equivalent suite. `.github/workflows/ci.yml` and
# agents both call these stages, so the commands cannot drift apart. Stages run
# in sequence: two suites in parallel fail spuriously.
set -euo pipefail

# Hermetic against ambient overrides: an inherited CHAT_REPO_URL or
# RECURSE_SELF_DEPLOY would redirect test targets instead of testing defaults.
unset CHAT_REPO_URL RECURSE_SELF_DEPLOY

cd "$(dirname "$0")/.."

stage_web() {
  bun run format:check
  bun run test
  bun run build
}

# Backend and extension formatting, types and tests.
stage_ts() {
  bun run format:backend:check
  # The static gate checks types with tsgo; tsc stays the reference here.
  bun run typecheck
  bun run typecheck:backend
  bun run typecheck:browser-tests
  # Compose the whole TypeScript server without listening, against a
  # throwaway state root.
  bun src/server.ts --check
  bun run test:backend
}

stage_browser() {
  # A dist built at another commit makes the change's own new assertion fail and
  # reads exactly like a real regression.
  bun run build
  # --with-deps installs system libraries and needs root. Where it cannot
  # elevate, install the browser alone; the test finds pixi global libraries
  # (`pixi global install libgbm`) and otherwise skips naming what is missing.
  bun x --bun playwright install --with-deps chromium ||
    bun x --bun playwright install chromium
  # One fresh server per migrated TypeScript feature group; readiness polls
  # /api/tree until startup maintenance has settled.
  bun run test:browser
}

stage_perf() {
  bun tests/dev/hotpath_gates.ts
}

stage_tla() {
  specs/tla/check.sh
}

# Routine reply-path coverage; browser tools must already be installed.
stage_provider() {
  bun run build
  bun test tests/backend/provider_replay.test.ts tests/backend/provider_websocket.test.ts tests/backend/provider_e2e.test.ts tests/backend/record_provider.test.ts --timeout 15000
  bun tests/mobile_browser/index.ts --workers 1 provider-replay
}

# Backend tests that cover the macOS port (src/utils/macos.md). /var and /tmp are
# links on macOS, so tests get the resolved temporary directory. Every step
# runs even after a failure, and a summary names the failed steps.
macos_step() {
  local label="$1"
  shift
  echo "== macos: $label"
  set +e
  "$@"
  local status=$?
  set -e
  # Invariant: plain strings, not arrays: macOS bash 3.2 with `set -u` rejects
  # expanding an empty array.
  if [[ $status -eq 0 ]]; then
    macos_results="${macos_results}passed: $label"$'\n'
  else
    macos_failures=$((macos_failures + 1))
    macos_results="${macos_results}FAILED: $label (exit $status)"$'\n'
  fi
  echo "== macos: $label: exit $status"
}

stage_macos() {
  TMPDIR="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
  export TMPDIR
  macos_results=""
  macos_failures=0
  macos_step "server --check" bun src/server.ts --check
  macos_step "file operations" bun test --timeout 30000 \
    tests/backend/flock.test.ts tests/backend/local_roots.test.ts \
    tests/backend/dir_fd.test.ts tests/backend/trash.test.ts \
    tests/backend/deleted_bin.test.ts tests/backend/memory_snapshot.test.ts \
    tests/backend/mutation_guard.test.ts tests/backend/session_files.test.ts \
    tests/backend/session_index.test.ts tests/backend/agent_temp.test.ts \
    tests/backend/attachment_drafts.test.ts tests/backend/preview.test.ts \
    tests/backend/publish.test.ts \
    tests/backend/extras_cli.test.ts
  macos_step "process identity" bun test --timeout 30000 \
    tests/backend/process_table.test.ts \
    tests/backend/process_lifecycle.test.ts tests/backend/pi_bg_shell.test.ts \
    tests/extensions/core/shells/persist.test.ts \
    tests/extensions/core/shells/recovery.test.ts \
    tests/extensions/core/shells/registry.test.ts \
    tests/extensions/core/safety/review.test.ts
  macos_step "supervisor lock" bun test --timeout 30000 \
    tests/backend/local_supervisor.test.ts \
    --test-name-pattern 'test_supervisor_lock_survives_reexec_without_reacquiring'
  echo "== macos summary: $macos_failures failed"
  printf '%s' "$macos_results"
  [[ $macos_failures -eq 0 ]]
}

# Every stage starts with installed dependencies and the fast static gate:
# docs and Markdown length, source sizes, web style, policy, lint and types.
bun src/launcher/dependencies.ts
bun tests/checks/static.ts

case "${1:-all}" in
  web | ts | browser | provider | perf | tla | macos) "stage_$1" ;;
  all)
    stage_web
    stage_ts
    stage_browser
    stage_perf
    stage_tla
    ;;
  *)
    echo "usage: $0 [web|ts|browser|provider|perf|tla|macos|all]" >&2
    exit 2
    ;;
esac
