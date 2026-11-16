#!/usr/bin/env bash
# Pinned Linux x64 tools and all TLC output stay in scratch.
# Usage: specs/tla/check.sh [all|idle-compaction|idle-compaction-<control>|send|send-reload-id|send-restart-ledger|send-stale-steer|send-stop-drop|send-restart-drop|send-reverse|send-interrupt-retry|viewport|unread|fixed-exclusive|fixed-normal|cold|search|cache|cold-read|search-read|cold-reopen|native|shell|shell-pins|shell-flush|shell-completion|admission|admission-reservation|admission-preparation|relay|relay-id|relay-startup|relay-idle|relay-wake|relay-revoked|relay-stale|trace]
set -euo pipefail

case "$(uname -sm)" in
  'Linux x86_64') ;;
  *) printf 'This pilot pins a Linux x64 JRE.\n' >&2; exit 2 ;;
esac
selected=${1:-all}
case "$selected" in
  all|idle-compaction|idle-compaction-cancel|idle-compaction-waiting|idle-compaction-strict-min|idle-compaction-no-warm|idle-compaction-minimum|idle-compaction-turn|idle-compaction-queue|idle-compaction-tree|idle-compaction-coupled|idle-compaction-compact-switch|idle-compaction-warm-switch|idle-compaction-deadline|idle-compaction-recheck|idle-compaction-renewal|send|send-reload-id|send-restart-ledger|send-stale-steer|send-stop-drop|send-restart-drop|send-reverse|send-interrupt-retry|viewport|unread|fixed-exclusive|fixed-normal|cold|search|cache|cold-read|search-read|cold-reopen|native|shell|shell-pins|shell-flush|shell-completion|admission|admission-reservation|admission-preparation|relay|relay-id|relay-startup|relay-idle|relay-wake|relay-revoked|relay-stale|trace) ;;
  *) printf 'Unknown case: %s\n' "$selected" >&2; exit 2 ;;
esac
if (( $# > 1 )); then printf 'Expected at most one case name.\n' >&2; exit 2; fi

scratch=${RECURSE_AGENT_TMPDIR:-${TMPDIR:?Set TMPDIR to a private scratch directory}}
tools="$scratch/tla-tools"
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$tools"

fetch() {
  local url=$1 path=$2 hash=$3
  if printf '%s  %s\n' "$hash" "$path" | sha256sum --check --status 2>/dev/null; then return; fi
  curl --fail --location --silent --show-error --retry 2 \
    --connect-timeout 20 --max-time 180 "$url" -o "$path.part"
  if ! printf '%s  %s\n' "$hash" "$path.part" | sha256sum --check --status; then
    printf 'SHA-256 mismatch for %s\n' "$url" >&2
    exit 1
  fi
  mv -- "$path.part" "$path"
}

fetch 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar' \
  "$tools/tla2tools.jar" 936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
fetch 'https://cdn.azul.com/zulu/bin/zulu21.40.17-ca-jre21.0.6-linux_x64.tar.gz' \
  "$tools/jre.tar.gz" 8524ef3c76ae1e00bb020044557c5ae1a59d985eee0394d71fc9b2414d083d33
java="$tools/zulu21.40.17-ca-jre21.0.6-linux_x64/bin/java"
if [[ ! -x "$java" ]]; then tar -xzf "$tools/jre.tar.gz" -C "$tools"; fi
run=$(mktemp -d "$scratch/store-lifecycle.XXXXXX")
cp -- "$source_dir/StoreLifecycle.tla" "$source_dir/ShellHandoff.tla" "$source_dir/LifecycleAdmission.tla" \
  "$source_dir/ViewportHolds.tla" "$source_dir/UnreadSeen.tla" "$source_dir/IdleCompaction.tla" \
  "$source_dir/relay/RemoteRelay.tla" "$source_dir/send/OperatorSend.tla" "$run/"
printf 'Logs and generated configs: %s\n' "$run"
"$java" -version

run_case() {
  local name=$1 cold=FALSE search=FALSE cache=FALSE exclusive=TRUE expected='' invariants=''
  local model=StoreLifecycle pins=FALSE flush=FALSE completion=FALSE
  local reservation=FALSE preparation=FALSE bug=none
  case "$name" in
    idle-compaction) model=IdleCompaction ;;
    idle-compaction-*)
      model=IdleCompaction; bug=${name#idle-compaction-}
      case "$bug" in
        waiting|coupled|strict-min) expected=BeforeExpiry ;;
        no-warm) expected=WaitingWarms ;;
        minimum) expected=MinimumRequired ;;
        turn) expected=OwnTurnFinished ;;
        queue) expected=InputQueueEmpty ;;
        tree) expected=WarmingWaitsForTree ;;
        compact-switch|warm-switch) expected=SwitchesIndependent ;;
        deadline) expected=DeadlineRespected ;;
        recheck) expected=CurrentCapture ;;
        renewal) expected=NoDoubleExpiry ;;
        cancel) expected=CancellationFinal ;;
      esac
      invariants="TypeOK $expected" ;;
    send) model=OperatorSend ;;
    send-reload-id|send-restart-ledger)
      model=OperatorSend; bug=${name#send-}; expected=SingleDelivery ;;
    send-stale-steer|send-stop-drop|send-restart-drop)
      model=OperatorSend; bug=${name#send-}; expected=MessageAccounted ;;
    send-reverse) model=OperatorSend; bug=reverse; expected=AdmissionOrder ;;
    send-interrupt-retry) model=OperatorSend; bug=interrupt-retry; expected=RetryKeepsRun ;;
    viewport) model=ViewportHolds ;;
    viewport-pin-blind|viewport-paint-blind|viewport-pane-keys|viewport-follow-offset|viewport-scripted-scroll)
      model=ViewportHolds; bug=${name#viewport-}; expected=ReaderWins ;;
    viewport-queued-anchor|viewport-disclosure-follow)
      model=ViewportHolds; bug=${name#viewport-}; expected=OneHold ;;
    viewport-natural-follow)
      model=ViewportHolds; bug=natural-follow; expected=PendingBottom
      invariants=$expected ;;
    viewport-natural-bottom)
      model=ViewportHolds; bug=natural-follow; expected=NaturalFollow
      invariants=$expected ;;
    viewport-paint-jump|viewport-jump-shift|viewport-jump-gap)
      model=ViewportHolds; bug=${name#viewport-}; expected=JumpLands ;;
    viewport-hide-jump|viewport-noop-jump)
      model=ViewportHolds; bug=${name#viewport-}; expected=JumpEnds ;;
    viewport-*) model=ViewportHolds; bug=${name#viewport-}; expected=HoldKept ;;
    relay) model=RemoteRelay ;;
    relay-id) model=RemoteRelay; bug=unstable-id; expected=SingleDelivery ;;
    relay-startup) model=RemoteRelay; bug=startup-drop; expected=NoPrematureLoss ;;
    relay-idle) model=RemoteRelay; bug=idle-pause; expected=PauseOnlyIdle ;;
    relay-wake) model=RemoteRelay; bug=poll-wake; expected=NoPollingWake ;;
    relay-revoked) model=RemoteRelay; bug=revoked-poll; expected=NoAutomaticWhileRevoked ;;
    relay-stale) model=RemoteRelay; bug=stale-success; expected=RevocationOwnership ;;
    unread) model=UnreadSeen ;;
    unread-unfenced) model=UnreadSeen; bug=unfenced; expected=ShownCurrent ;;
    unread-*) model=UnreadSeen; bug=${name#unread-}; expected=DotMatches ;;
    admission) model=LifecycleAdmission ;;
    admission-reservation) model=LifecycleAdmission; reservation=TRUE; expected=BusyOnlyIfHeld ;;
    admission-preparation) model=LifecycleAdmission; preparation=TRUE; expected=BusyOnlyIfHeld ;;
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
  local template="$source_dir/$model.cfg"
  if [[ "$model" = RemoteRelay ]]; then template="$source_dir/relay/$model.cfg"; fi
  if [[ "$model" = OperatorSend ]]; then template="$source_dir/send/$model.cfg"; fi
  while IFS= read -r line; do
    case "$line" in
      '  ColdViewBug = '*) line="  ColdViewBug = $cold" ;;
      '  SearchFenceBug = '*) line="  SearchFenceBug = $search" ;;
      '  PrepareCacheBug = '*) line="  PrepareCacheBug = $cache" ;;
      '  Exclusive = '*) line="  Exclusive = $exclusive" ;;
      '  ReadPinBug = '*) line="  ReadPinBug = $pins" ;;
      '  FlushBug = '*) line="  FlushBug = $flush" ;;
      '  CompletionHandoffBug = '*) line="  CompletionHandoffBug = $completion" ;;
      '  ReservationDeadlineBug = '*) line="  ReservationDeadlineBug = $reservation" ;;
      '  PreparationDeadlineBug = '*) line="  PreparationDeadlineBug = $preparation" ;;
      '  Bug = '*) line="  Bug = \"$bug\"" ;;
      INVARIANTS*) if [[ -n "$invariants" ]]; then line="INVARIANTS $invariants"; fi ;;
    esac
    printf '%s\n' "$line"
  done < "$template" > "$run/$name.cfg"

  local status=0 start=$SECONDS
  (cd "$run" && timeout 110 "$java" -Djava.io.tmpdir="$run" -Xmx1g -XX:+UseParallelGC \
    -cp "$tools/tla2tools.jar" tlc2.TLC -workers 1 -seed 1 -fp 0 \
    -metadir "$run/$name.states" \
    -config "$run/$name.cfg" "$model.tla") \
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

idle_cases='idle-compaction idle-compaction-waiting idle-compaction-minimum
  idle-compaction-strict-min idle-compaction-no-warm
  idle-compaction-turn idle-compaction-queue idle-compaction-tree
  idle-compaction-coupled idle-compaction-compact-switch idle-compaction-warm-switch
  idle-compaction-deadline idle-compaction-recheck idle-compaction-renewal
  idle-compaction-cancel'
viewport_cases='viewport viewport-pin-blind viewport-paint-blind viewport-queued-smooth
  viewport-paint-clamp viewport-layout-clamp viewport-follow-offset viewport-jump-follow
  viewport-pane-keys viewport-hidden-layout viewport-unsettled viewport-delayed-layout
  viewport-scripted-scroll viewport-queued-anchor viewport-paint-jump
  viewport-hide-jump viewport-jump-shift viewport-jump-gap viewport-noop-jump
  viewport-natural-follow viewport-natural-bottom viewport-disclosure-follow'
send_cases='send send-reload-id send-restart-ledger send-stale-steer
  send-stop-drop send-restart-drop send-reverse send-interrupt-retry'
unread_cases='unread unread-drain unread-aborted-ack unread-unfenced'
for name in $idle_cases fixed-exclusive fixed-normal cold search cache cold-read search-read cold-reopen native shell shell-pins shell-flush shell-completion admission admission-reservation admission-preparation $viewport_cases $unread_cases $send_cases relay relay-id relay-startup relay-idle relay-wake relay-revoked relay-stale; do
  if [[ "$selected" = all || "$selected" = "$name" || ( "$selected" = viewport && "$name" = viewport* ) || ( "$selected" = unread && "$name" = unread* ) || ( "$selected" = idle-compaction && "$name" = idle-compaction* ) || ( "$selected" = send && "$name" = send* ) ]]; then
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
