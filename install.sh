#!/usr/bin/env bash
# Install or update a checkout and a small `recurse` command shim.
#
# By default the checkout is the newest vX.Y.Z release tag of RECURSE_REPO
# (main when it has no release tags yet). RECURSE_VERSION=0.1.0 pins a release;
# RECURSE_BRANCH=main tracks a branch. Rerunning updates an existing checkout
# the same way. The checkout records that channel ("release", "version X.Y.Z"
# or "branch NAME") in its Git config as recurse.channel.
#
# Run from a checkout, `install.sh --update` (what `recurse update` runs) moves
# that checkout in place along its recorded channel and leaves the shim alone;
# a checkout with no record follows the release tag its HEAD is on. `install.sh --check` prints channel=, installed= and
# available= lines (the ref --update would move to) and changes nothing. Both
# exit 3 for a checkout with no channel. RECURSE_VERSION or RECURSE_BRANCH
# switches the channel explicitly.
set -euo pipefail
umask 077

log() { printf '\033[36m[recurse]\033[0m %s\n' "$*" >&2; }
need() {
  if command -v "$1" >/dev/null 2>&1; then return 0; fi
  echo "error: '$1' is required but not on PATH" >&2
  exit 1
}

MODE=install
case "$#:${1:-}" in
  0:) ;;
  1:--update) MODE=update ;;
  1:--check) MODE=check ;;
  *)
    echo "usage: install.sh [--update | --check]" >&2
    exit 2 ;;
esac

if [ -n "${RECURSE_CODE_HOME+x}" ]; then
  echo "RECURSE_CODE_HOME is no longer used; tools build under <checkout>/.recurse" >&2
  unset RECURSE_CODE_HOME
fi

if [ -n "${RECURSE_ISOLATED_ROOT+x}" ]; then
  INSTALL_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  if [ ! -f "$INSTALL_SOURCE_DIR/src/launch_cli.ts" ]; then
    echo "error: isolated install requires a Recurse checkout" >&2
    exit 2
  fi
fi

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

need git
RECURSE_REPO="${RECURSE_REPO:-https://github.com/ebetica/recurse.git}"
if [ -n "${RECURSE_BRANCH:-}" ] && [ -n "${RECURSE_VERSION:-}" ]; then
  echo "error: set RECURSE_VERSION or RECURSE_BRANCH, not both" >&2
  exit 1
fi

# Print the newest vX.Y.Z tag at HEAD of checkout $1, if any.
release_tag() {
  local tag
  while read -r tag; do
    if [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      printf '%s\n' "$tag"
      return 0
    fi
  done < <(git -C "$1" tag --points-at HEAD --sort=-v:refname)
}

# Set CHANNEL from RECURSE_BRANCH or RECURSE_VERSION, else "release". Given
# checkout $1, prefer its recorded channel, then the release tag its HEAD is
# on; fail for a checkout with neither, such as a development clone.
choose_channel() {
  local dir="${1:-}"
  if [ -n "${RECURSE_BRANCH:-}" ]; then
    CHANNEL="branch $RECURSE_BRANCH"
    return 0
  fi
  if [ -n "${RECURSE_VERSION:-}" ]; then
    CHANNEL="version ${RECURSE_VERSION#v}"
    return 0
  fi
  CHANNEL=release
  [ -n "$dir" ] || return 0
  CHANNEL="$(git -C "$dir" config --get recurse.channel)" && return 0
  CHANNEL=release
  [ -n "$(release_tag "$dir")" ]
}

# Set INSTALL_KIND (tag or branch) and INSTALL_REF for CHANNEL; the release
# channel takes the newest vX.Y.Z tag of remote $2, listed from directory $1.
choose_ref() {
  local newest="" tags ref
  case "$CHANNEL" in
    "branch "*)
      INSTALL_KIND=branch INSTALL_REF="${CHANNEL#branch }"
      return 0 ;;
    "version "*)
      INSTALL_KIND=tag INSTALL_REF="v${CHANNEL#version }"
      return 0 ;;
    release) ;;
    *)
      echo "error: unknown recurse.channel: $CHANNEL" >&2
      return 1 ;;
  esac
  tags="$(git -C "$1" ls-remote --tags --refs --sort=-v:refname "$2")" || return 1
  while read -r _ ref; do
    if [[ "${ref#refs/tags/}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      newest="${ref#refs/tags/}"
      break
    fi
  done <<< "$tags"
  if [ -n "$newest" ]; then
    INSTALL_KIND=tag INSTALL_REF="$newest"
  else
    log "no release tags yet; installing the main branch"
    INSTALL_KIND=branch INSTALL_REF=main
  fi
}

# Move the checkout at $1 to INSTALL_REF: a detached release tag, or the branch
# fast-forwarded to its remote. Local changes that conflict stop the update.
update_checkout() {
  local dir="$1"
  if [ "$INSTALL_KIND" = tag ]; then
    git -C "$dir" fetch -q origin "+refs/tags/$INSTALL_REF:refs/tags/$INSTALL_REF" &&
      git -C "$dir" -c advice.detachedHead=false checkout -q --detach "refs/tags/$INSTALL_REF"
  else
    git -C "$dir" fetch -q origin "+refs/heads/$INSTALL_REF:refs/remotes/origin/$INSTALL_REF" &&
      git -C "$dir" checkout -q "$INSTALL_REF" &&
      git -C "$dir" merge -q --ff-only "origin/$INSTALL_REF"
  fi
}

# --update and --check work on the checkout this script is in.
if [ "$MODE" != install ]; then
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  if [ ! -e "$dir/.git" ]; then
    echo "error: $dir is not a Git checkout; reinstall with install.sh" >&2
    exit 3
  fi
  if ! choose_channel "$dir"; then
    echo "error: $dir is not on a release tag and install.sh recorded no channel for it; update it with Git, or rerun install.sh (RECURSE_BRANCH=NAME to track a branch)" >&2
    exit 3
  fi
  choose_ref "$dir" origin
  head="$(git -C "$dir" rev-parse HEAD)"
  if [ "$MODE" = check ]; then
    installed="$(release_tag "$dir")"
    available="$INSTALL_REF"
    if [ "$INSTALL_KIND" = branch ]; then
      installed="" available="$(git -C "$dir" ls-remote origin "refs/heads/$INSTALL_REF")"
      available="${available%%[[:space:]]*}"
      if [ -z "$available" ]; then
        echo "error: origin has no branch $INSTALL_REF" >&2
        exit 1
      fi
      if git -C "$dir" merge-base --is-ancestor "$available" HEAD 2>/dev/null; then
        available="$head"
      fi
      available="${available:0:7}"
    fi
    printf 'channel=%s\ninstalled=%s\navailable=%s\n' \
      "$CHANNEL" "${installed:-${head:0:7}}" "$available"
    exit 0
  fi
  log "updating recurse checkout to $INSTALL_REF…"
  if ! update_checkout "$dir"; then
    log "update failed. Fix the Git error and rerun recurse update."
    exit 1
  fi
  git -C "$dir" config recurse.channel "$CHANNEL"
  if [ "$(git -C "$dir" rev-parse HEAD)" = "$head" ]; then
    log "already up to date at $INSTALL_REF"
  else
    log "updated to $INSTALL_REF; a running recurse restarts into it once no turn is running"
  fi
  exit 0
fi

INSTALL_DIR="${RECURSE_INSTALL_DIR:-$HOME/recurse}"
LEGACY_CHECKOUT="$HOME/.recurse/recurse"
UPDATE_STAGE="${INSTALL_DIR}.update"

# Refuse control characters, a relative path or `/`, and any existing path
# component that is a symlink or not a directory.
validate_install_dir() {
  local path="$1" rest part current=""
  case "$path" in
    *[[:cntrl:]]*)
      echo "error: RECURSE_INSTALL_DIR must not contain control characters" >&2
      exit 1 ;;
  esac
  case "$path" in
    "~") path="$HOME" ;;
    "~/"*) path="$HOME/${path#"~/"}" ;;
  esac
  rest="${path#/}"
  case "$path" in /*) ;; *) rest="" ;; esac
  if [ -z "${rest//\//}" ]; then
    echo "error: RECURSE_INSTALL_DIR must be an absolute directory" >&2
    exit 1
  fi
  while [ -n "$rest" ]; do
    part="${rest%%/*}"
    if [ "$part" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi
    if [ -z "$part" ] || [ "$part" = "." ]; then continue; fi
    current="$current/$part"
    if [ ! -e "$current" ] && [ ! -L "$current" ]; then break; fi
    if [ -L "$current" ] || [ ! -d "$current" ]; then
      echo "error: unsafe install directory component: $current" >&2
      exit 1
    fi
  done
}
validate_install_dir "$INSTALL_DIR"

# Move the old default checkout when possible. A failed cross-device or policy
# rename leaves it usable and makes this install continue from that location.
if [ ! -e "$INSTALL_DIR" ] && [ -d "$LEGACY_CHECKOUT/.git" ]; then
  if mv -- "$LEGACY_CHECKOUT" "$INSTALL_DIR"; then
    log "moved legacy checkout → $INSTALL_DIR"
  else
    INSTALL_DIR="$LEGACY_CHECKOUT"
    UPDATE_STAGE="${INSTALL_DIR}.update"
    log "could not move legacy checkout; continuing at $INSTALL_DIR"
  fi
fi

if [ -L "$INSTALL_DIR" ] || [ -L "$UPDATE_STAGE" ]; then
  echo "error: checkout and update stage must not be symlinks" >&2
  exit 1
fi

choose_channel
if [ -d "$UPDATE_STAGE/.git" ]; then
  if [ -e "$INSTALL_DIR" ]; then
    echo "error: conflicting checkout and interrupted update stage" >&2
    exit 1
  fi
  log "retrying interrupted recurse checkout update…"
elif [ -d "$INSTALL_DIR/.git" ]; then
  mv -- "$INSTALL_DIR" "$UPDATE_STAGE"
elif [ -e "$INSTALL_DIR" ] || [ -e "$UPDATE_STAGE" ]; then
  echo "error: install path is not a Recurse checkout" >&2
  exit 1
else
  choose_ref . "$RECURSE_REPO"
  log "cloning recurse $INSTALL_REF…"
  git -c advice.detachedHead=false clone --branch "$INSTALL_REF" "$RECURSE_REPO" "$INSTALL_DIR"
fi

if [ -d "$UPDATE_STAGE/.git" ]; then
  updated=0
  previous="$(git -C "$UPDATE_STAGE" config --get recurse.channel || true)"
  if [ -n "$previous" ] && [ "$previous" != "$CHANNEL" ]; then
    log "switching the update channel from $previous to $CHANNEL"
  fi
  if choose_ref "$UPDATE_STAGE" origin; then
    log "updating recurse checkout to $INSTALL_REF…"
    update_checkout "$UPDATE_STAGE" && updated=1
  fi
  if [ "$updated" != 1 ]; then
    mv -- "$UPDATE_STAGE" "$INSTALL_DIR"
    log "update failed; restored checkout at $INSTALL_DIR. Fix the Git error and rerun install.sh."
    exit 1
  fi
  mv -- "$UPDATE_STAGE" "$INSTALL_DIR"
fi
git -C "$INSTALL_DIR" config recurse.channel "$CHANNEL"

# Preserve an explicitly selected state root across shim launches. The default
# remains dynamically XDG-based and needs no checkout configuration.
# An interrupted rewrite or shim publication leaves no temporary copy behind.
env_tmp="" shim_tmp=""
trap 'rm -f -- ${env_tmp:+"$env_tmp"} ${shim_tmp:+"$shim_tmp"}' EXIT
if [ -n "${RECURSE_HOME:-}" ]; then
  touch "$INSTALL_DIR/.env"; chmod 600 "$INSTALL_DIR/.env"
  env_tmp="$(mktemp "$INSTALL_DIR/.env.XXXXXX")"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in RECURSE_HOME=*) ;; *) printf '%s\n' "$line" ;; esac
  done < "$INSTALL_DIR/.env" > "$env_tmp"
  printf 'RECURSE_HOME=%s\n' "$RECURSE_HOME" >> "$env_tmp"
  chmod 600 "$env_tmp"
  mv -f -- "$env_tmp" "$INSTALL_DIR/.env"
  env_tmp=""
fi

BIN_DIR="${RECURSE_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
# The managed shim, published by one rename of a complete executable file.
shim_tmp="$(mktemp "$BIN_DIR/.recurse.XXXXXX")"
{
  printf '#!/usr/bin/env bash\n# recurse-managed-launcher-v2\nset -euo pipefail\n'
  printf 'exec %q/recurse "$@"\n' "$INSTALL_DIR"
} > "$shim_tmp"
chmod 755 "$shim_tmp"
mv -f -- "$shim_tmp" "$BIN_DIR/recurse"
shim_tmp=""

legacy_tools=()
for name in pi fff pi-context-window pi-bg-shell pi-recurse rtk-pi .build-stamp.json; do
  [ -e "$HOME/.recurse/$name" ] && legacy_tools+=("$name")
done
if [ "${#legacy_tools[@]}" -gt 0 ]; then
  log "legacy ~/.recurse/{pi,fff,pi-context-window,pi-bg-shell,pi-recurse,rtk-pi,.build-stamp.json} can be removed"
fi
log "installed 'recurse' command → $BIN_DIR/recurse"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) log "note: $BIN_DIR is not on your PATH" ;;
esac
log "install complete — checkout at $INSTALL_DIR; start recurse with: recurse <target>"
