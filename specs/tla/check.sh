#!/usr/bin/env bash
# Pinned Linux x64 tools and all TLC output stay in scratch.
# Usage: specs/tla/check.sh [all|fixed-exclusive|fixed-normal|cold|search|cache|cold-read|search-read|cold-reopen|native|shell|shell-pins|shell-flush|shell-completion|trace]
set -euo pipefail

case "$(uname -sm)" in
  'Linux x86_64') ;;
  *) printf 'This pilot pins a Linux x64 JRE.\n' >&2; exit 2 ;;
esac
selected=${1:-all}
case "$selected" in
  all|fixed-exclusive|fixed-normal|cold|search|cache|cold-read|search-read|cold-reopen|native|shell|shell-pins|shell-flush|shell-completion|trace) ;;
  *) printf 'Unknown case: %s\n' "$selected" >&2; exit 2 ;;
esac
if (( $# > 1 )); then printf 'Expected at most one case name.\n' >&2; exit 2; fi

scratch=${RECURSE_AGENT_TMPDIR:-${TMPDIR:?Set TMPDIR to a private scratch directory}}
tools="$scratch/tla-tools"
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$tools"

fetch() {
  local url=$1 path=$2 hash=$3
  if [[ ! -f "$path" ]]; then
    curl --fail --location --silent --show-error --retry 2 \
      --connect-timeout 20 --max-time 180 "$url" -o "$path.part"
    printf '%s  %s\n' "$hash" "$path.part" | sha256sum --check --status
    mv -- "$path.part" "$path"
  fi
  printf '%s  %s\n' "$hash" "$path" | sha256sum --check --status
}

fetch 'https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar' \
  "$tools/tla2tools.jar" c57d4d7bbee3ed2c89c32cb9c60cac728f751e80e2570bc4b7368ae39291fc21
fetch 'https://cdn.azul.com/zulu/bin/zulu21.40.17-ca-jre21.0.6-linux_x64.tar.gz' \
  "$tools/jre.tar.gz" 8524ef3c76ae1e00bb020044557c5ae1a59d985eee0394d71fc9b2414d083d33
java="$tools/zulu21.40.17-ca-jre21.0.6-linux_x64/bin/java"
if [[ ! -x "$java" ]]; then tar -xzf "$tools/jre.tar.gz" -C "$tools"; fi
run=$(mktemp -d "$scratch/store-lifecycle.XXXXXX")
printf 'Logs and generated configs: %s\n' "$run"
"$java" -version

run_case() {
  local name=$1 cold=FALSE search=FALSE cache=FALSE exclusive=TRUE expected='' invariants=''
  local model=StoreLifecycle pins=FALSE flush=FALSE completion=FALSE
  case "$name" in
    shell) model=ShellHandoff ;;
    shell-pins) model=ShellHandoff; pins=TRUE; expected=OutputRetained ;;
    shell-flush) model=ShellHandoff; flush=TRUE; expected=HandoffSettled ;;
    shell-completion) model=ShellHandoff; completion=TRUE; expected=CompletionResponsibility ;;
    fixed-normal) exclusive=FALSE ;;
    cold) cold=TRUE; expected=RotationClosed ;;
    search) search=TRUE; expected=RotationClosed ;;
    cache) cache=TRUE; expected=SearchCacheCoherent ;;
    cold-read) cold=TRUE; expected=NoReadMoved; invariants='TypeOK NoReadMoved' ;;
    search-read) search=TRUE; expected=NoReadMoved; invariants='TypeOK NoReadMoved' ;;
    cold-reopen) cold=TRUE; expected=OwnerConnectionCurrent; invariants='TypeOK OwnerConnectionCurrent' ;;
    native) cold=TRUE; expected=NoNativeRenameCrash; invariants='TypeOK NoNativeRenameCrash' ;;
  esac
  while IFS= read -r line; do
    case "$line" in
      '  ColdViewBug = '*) line="  ColdViewBug = $cold" ;;
      '  SearchFenceBug = '*) line="  SearchFenceBug = $search" ;;
      '  PrepareCacheBug = '*) line="  PrepareCacheBug = $cache" ;;
      '  Exclusive = '*) line="  Exclusive = $exclusive" ;;
      '  ReadPinBug = '*) line="  ReadPinBug = $pins" ;;
      '  FlushBug = '*) line="  FlushBug = $flush" ;;
      '  CompletionHandoffBug = '*) line="  CompletionHandoffBug = $completion" ;;
      INVARIANTS*) if [[ -n "$invariants" ]]; then line="INVARIANTS $invariants"; fi ;;
    esac
    printf '%s\n' "$line"
  done < "$source_dir/$model.cfg" > "$run/$name.cfg"

  local status=0 start=$SECONDS
  timeout 110 "$java" -Djava.io.tmpdir="$run" -Xmx1g -XX:+UseParallelGC \
    -cp "$tools/tla2tools.jar" tlc2.TLC -workers 1 -seed 1 -fp 0 \
    -noGenerateSpecTE -metadir "$run/$name.states" \
    -config "$run/$name.cfg" "$source_dir/$model.tla" \
    > "$run/$name.log" 2>&1 || status=$?
  printf '\n%s: exit=%s elapsed=%ss\n' "$name" "$status" "$((SECONDS - start))"
  awk '/TLC2 Version|Error:|No error has been found|states generated,|depth of|Finished in/' "$run/$name.log"
  if [[ -z "$expected" ]]; then
    [[ "$status" = 0 ]] && awk '/Model checking completed. No error has been found./ {ok=1} END {exit !ok}' "$run/$name.log"
  else
    [[ "$status" = 12 ]] && awk -v message="Error: Invariant $expected is violated." \
      'index($0, message) {ok=1} END {exit !ok}' "$run/$name.log"
  fi
}

for name in fixed-exclusive fixed-normal cold search cache cold-read search-read cold-reopen native shell shell-pins shell-flush shell-completion; do
  if [[ "$selected" = all || "$selected" = "$name" ]]; then
    if ! run_case "$name"; then
      printf 'Unexpected TLC result; inspect %s/%s.log\n' "$run" "$name" >&2
      exit 1
    fi
  fi
done
if [[ "$selected" = all || "$selected" = trace ]]; then
  bun "$source_dir/../../tests/dev/rotation_trace.ts" "$java" "$tools/tla2tools.jar" "$run"
fi
printf '\nPASS: fixed cases exhaust; buggy cases violate their expected invariant.\n'
