#!/usr/bin/env bash
# The one definition of the CI-equivalent suite. `.github/workflows/ci.yml` and
# agents both call these stages, so the commands cannot drift apart. Stages run
# in sequence: two suites in parallel fail spuriously.
set -euo pipefail

# Hermetic against ambient overrides: an inherited CHAT_REPO_URL or
# RECURSE_SELF_DEPLOY would redirect test targets instead of testing defaults.
unset CHAT_REPO_URL RECURSE_SELF_DEPLOY

cd "$(dirname "$0")/.."

advisory_lint() {
  local label="$1"
  shift
  set +e
  "$@"
  local status=$?
  set -e
  if [[ $status -eq 0 ]]; then
    return 0
  fi
  if [[ $status -eq 1 ]]; then
    echo "ADVISORY: $label reported findings" >&2
    return 0
  fi
  echo "ERROR: $label could not run (exit $status)" >&2
  return "$status"
}

stage_web() {
  bun src/launcher/dependencies.ts
  bun run format:check
  bun tests/checks/color_check.ts
  bun tests/checks/radius_check.ts
  bun tests/checks/shadow_check.ts
  bun tests/checks/font_check.ts
  bun tests/checks/svg_check.ts
  bun tests/checks/z_check.ts
  bun tests/checks/motion_check.ts
  bun tests/checks/space_check.ts
  bun --bun ./node_modules/.bin/oxlint -c .oxlintrc.json --print-config >/dev/null
  advisory_lint "Oxlint" bun run lint
  bun run test
  bun run typecheck
  bun run build
}

# Backend and extension formatting/types/tests, docs links, and tracked Markdown (under 15,000 characters) and source size limits.
stage_ts() {
  bun tests/checks/docs_check.ts
  bun -e '
    import { lstatSync, readFileSync } from "node:fs";
    const limit = 15000;
    const tracked = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.md"]);
    if (tracked.exitCode !== 0) throw new Error(tracked.stderr.toString());
    for (const file of tracked.stdout.toString().split("\0").filter(Boolean)) {
      if (lstatSync(file).isSymbolicLink()) continue;
      const count = Array.from(readFileSync(file, "utf8")).length;
      if (count >= limit) { console.error(`${file}: ${count} characters (limit: fewer than ${limit})`); process.exitCode = 1; }
    }
  '
  # Exclude web/vendor/** (third-party), web/dist/** (build output),
  # scripts/patches/** (dependency diffs), **/fixtures/** (recorded/test inputs), and
  # **/*.lock (generated dependency metadata). Symlinks are not source files.
  bun -e '
    import { lstatSync, readFileSync } from "node:fs";
    const tracked = Bun.spawnSync(["git", "ls-files", "-z", "--", ".",
      ":(glob,exclude)web/vendor/**", ":(glob,exclude)web/dist/**",
      ":(glob,exclude)scripts/patches/**", ":(glob,exclude)**/fixtures/**", ":(glob,exclude)**/*.lock"]);
    if (tracked.exitCode !== 0) throw new Error(tracked.stderr.toString());
    const source = /\.(?:[cm]?[jt]sx?|py|sh|bash|html?|css|scss|sass|less|vue|svelte|c|h|cc|cpp|hpp|rs|go|java|rb)$/i;
    for (const file of tracked.stdout.toString().split("\0").filter(Boolean)) {
      if (lstatSync(file).isSymbolicLink()) continue;
      const text = readFileSync(file, "utf8");
      if (!source.test(file) && !text.startsWith("#!")) continue;
      const lines = text.split("\n").length - Number(text.endsWith("\n") || !text);
      if (lines > 2500) { console.error(`ERROR: ${file}: ${lines} lines (maximum 2500). A file this large usually means bloated code or a concern that should be its own module: simplify from first principles (delete dead, duplicated or parallel code, one job per module); do not mechanically split it.`); process.exitCode = 1; }
      else if (lines >= 1000) console.warn(`WARNING: ${file}: ${lines} lines (maximum 2500). A file this large often means bloated code or a concern that should be its own module: before adding more, look for dead, duplicated or parallel code to delete.`);
    }
  '
  bun src/launcher/dependencies.ts
  bun tests/checks/comment_check.ts --summary --strict
  bun tests/checks/test_check.ts --strict --summary
  bun run format:backend:check
  bun run typecheck:backend
  # Compose the whole TypeScript server without listening, against a
  # throwaway state root.
  bun src/server.ts --check
  bun run test:backend
  python3 playground/modal/test_deploy.py
}

stage_browser() {
  bun src/launcher/dependencies.ts
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

# Routine reply-path coverage; browser tools must already be installed.
stage_provider() {
  bun src/launcher/dependencies.ts
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
  bun src/launcher/dependencies.ts
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

case "${1:-all}" in
  web | ts | browser | provider | macos) "stage_$1" ;;
  all)
    stage_web
    stage_ts
    stage_browser
    ;;
  *)
    echo "usage: $0 [web|ts|browser|provider|macos|all]" >&2
    exit 2
    ;;
esac
