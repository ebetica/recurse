#!/usr/bin/env bash
# Record whether a supported RTK is installed. `./recurse` and each generation
# build run this; the Durable bash hook (src/extensions/extra/rtk/rtk.ts) rewrites
# commands through `rtk rewrite` only while <checkout>/.recurse/.rtk-status
# reads `ready:<version>`. RTK is optional: when it is missing or too old the
# status reads `disabled`, one warning is printed, and startup continues.
set -euo pipefail
umask 077

RTK_VERSION="0.43.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/../.recurse"
RTK_STATUS="$BUILD_DIR/.rtk-status"

rtk_supported() {
  local raw major minor patch req_major req_minor req_patch
  raw="$("$1" --version 2>/dev/null || true)"
  [[ "$raw" =~ ^rtk[[:space:]]+([0-9]+)\.([0-9]+)\.([0-9]+) ]] || return 1
  major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"; patch="${BASH_REMATCH[3]}"
  IFS=. read -r req_major req_minor req_patch <<<"$RTK_VERSION"
  (( major > req_major \
     || (major == req_major && minor > req_minor) \
     || (major == req_major && minor == req_minor && patch >= req_patch) ))
}

write_status() {
  local tmp="$RTK_STATUS.tmp.$$"
  mkdir -p "$BUILD_DIR"
  printf '%s\n' "$1" >"$tmp" && mv -f "$tmp" "$RTK_STATUS"
}

disable() {
  write_status disabled
  printf '[recurse] warning: RTK unavailable (%s); continuing without command-output compression. Install RTK %s or newer from https://github.com/rtk-ai/rtk/releases/tag/v%s to enable it.\n' \
    "$1" "$RTK_VERSION" "$RTK_VERSION" >&2
}

# Earlier releases installed RTK's Pi extension here; nothing loads it now.
rm -rf "$BUILD_DIR/rtk-pi"

rtk_bin="$(command -v rtk 2>/dev/null || true)"
if [ -z "$rtk_bin" ] || [ ! -f "$rtk_bin" ] || [ ! -x "$rtk_bin" ]; then
  disable "no usable RTK executable was found"
elif ! rtk_supported "$rtk_bin"; then
  disable "the installed RTK version is unsupported"
else
  write_status "ready:$RTK_VERSION"
  printf '[recurse] %s detected; shell output compression enabled.\n' \
    "$("$rtk_bin" --version 2>/dev/null | head -1)" >&2
fi
