#!/bin/bash
# Dress rehearsal of scripts/launch.sh against fakes (no Railway, no chain): Railway slow and failing the way it did
# during its incidents, `railway ssh` answering late or not at all, a build that fails. It times every step and counts
# the Railway and ssh calls, and checks that each failure ends with a clear next step and that a second run finishes
# what the first one started. Run: bash tests/scripts/launch-rehearsal.sh  (TIMINGS=1 prints the step timings)
# shellcheck disable=SC2016,SC2034 # each check is a string evaluated later (check), rc is read there
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
FAILS=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; FAILS=$((FAILS + 1)); fi; }
CREATOR=4VYWcTTDYyMVic58AcUC7Nodt6vNQwjKhA9UphaAKiot
PHRASE=I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS
mkdir -p "$W/bin" "$W/fake" "$W/home/rat-secrets"
now_ms() { date +%s%3N; }

# fake railway: slow (LAT_MS per call), and failing on demand:
#   fail_list N   the next N `variable list` calls fail like Railway's API did ("error decoding response body")
#   drop_key K    `variable set` answers OK but keeps nothing for K (a lost write)
#   polls N       a build reports BUILDING N times before its result
#   build_api R   the api build ends with R (FAILED, CRASHED), else SUCCESS
cat >"$W/bin/railway" <<'EOF'
#!/bin/bash
F="$FAKE_DIR"
sleep "$(awk -v m="${LAT_MS:-0}" 'BEGIN { printf "%.3f", m / 1000 }')"
svc=""; prev=""; for a in "$@"; do [ "$prev" = --service ] && svc="$a"; prev="$a"; done
echo "$(date +%s%3N) railway $1 ${2:-} $svc" >>"$F/calls.log"
dec() { n=$(cat "$F/$1" 2>/dev/null || echo 0); [ "$n" -gt 0 ] || return 1; echo $((n - 1)) >"$F/$1"; }
case "$1 ${2:-}" in
  "status --json") cat "$F/linked" ;;
  "variable list") if dec fail_list; then echo "Failed to fetch: error decoding response body" >&2; exit 1; fi; cat "$F/vars-$svc.json" ;;
  "variable set")
    shift 2
    for a in "$@"; do
      case "$a" in --*) break ;; *=*)
        [ "${a%%=*}" = "$(cat "$F/drop_key" 2>/dev/null)" ] && continue
        jq -c --arg k "${a%%=*}" --arg v "${a#*=}" '.[$k] = $v' "$F/vars-$svc.json" >"$F/v.tmp" && mv "$F/v.tmp" "$F/vars-$svc.json" ;; esac
    done ;;
  "redeploy --service")
    echo $(($(cat "$F/dep-$svc" 2>/dev/null || echo 0) + 1)) >"$F/dep-$svc"
    cat "$F/polls" 2>/dev/null >"$F/left-$svc" || true
    if [ "$svc" = worker ]; then
      if [ "$(jq -r .DRY_RUN "$F/vars-worker.json")" = false ]; then echo live >"$F/mode"; else echo dry_run >"$F/mode"; fi
    fi ;;
  "service status")
    s=SUCCESS
    if dec "left-$svc"; then s=BUILDING; elif [ "$svc" = api ] && [ -f "$F/build_api" ]; then s=$(cat "$F/build_api"); fi
    printf '{"status":"%s","deploymentId":"d%s"}\n' "$s" "$(cat "$F/dep-$svc" 2>/dev/null || echo 0)" ;;
esac
EOF
# fake rat (railway ssh into the worker): slow (SSH_MS), `fail_ssh N` makes the next N calls fail, `stale_status N`
# makes the next N status calls answer from the old DRY RUN container (still draining after a redeploy)
cat >"$W/bin/fake-rat" <<'EOF'
#!/bin/bash
F="$FAKE_DIR"
sleep "$(awk -v m="${SSH_MS:-0}" 'BEGIN { printf "%.3f", m / 1000 }')"
w=""; while [ "${1:-}" = --with ]; do w="$w $2"; shift 2; done
echo "$(date +%s%3N) ssh $1" >>"$F/calls.log"
dec() { n=$(cat "$F/$1" 2>/dev/null || echo 0); [ "$n" -gt 0 ] || return 1; echo $((n - 1)) >"$F/$1"; }
if dec fail_ssh; then echo "railway ssh: connection closed" >&2; exit 1; fi
case "$1" in
  status) m=$(cat "$F/mode"); [ "$m" = live ] && dec stale_status && m=dry_run; printf '{"mode":"%s","killSwitch":{"on":false}}\n' "$m" ;;
  preflight) echo '{"lines":[{"status":"PASS","check":"launch txs","detail":"ok"},{"status":"PASS","check":"dev buy","detail":"ok"},{"status":"PASS","check":"coin creator","detail":"ok"}]}' ;;
  dry-run-reset) echo "paper data reset" ;;
esac
EOF
cat >"$W/bin/curl" <<'EOF'
#!/bin/bash
d=""; prev=""; for a in "$@"; do [ "$prev" = -d ] && d="$a"; prev="$a"; done
cat >/dev/null
echo "$(date +%s%3N) rpc" >>"$FAKE_DIR/calls.log"
case "$d" in
  *getBalance*) echo '{"result":{"value":300000000}}' ;;
  *getSignaturesForAddress*'"limit":1}'*) echo '{"result":[{"signature":"sigBefore","slot":900,"err":null}]}' ;;
  *getSignaturesForAddress*) echo '{"result":[{"signature":"sigLaunch","slot":1000,"err":null,"blockTime":1700000000},{"signature":"sigBefore","slot":900,"err":null}]}' ;;
  *getTransaction*) printf '{"result":{"meta":{"postTokenBalances":[{"owner":"%s","mint":"MintLaunch","uiTokenAmount":{"amount":"3500000000000"}}]}}}\n' "$CREATOR_FAKE" ;;
  *) echo '{}' ;;
esac
EOF
chmod +x "$W/bin/"*
reset() {
  rm -f "$W/fake/"*
  echo '{"id":"proj-production","name":"wall-street-rats"}' >"$W/fake/linked"
  printf 'PROFILE=production\nRAILWAY_PROJECT_ID=proj-production\n' >"$W/home/rat-secrets/setup-state.env"
  printf '{"CREATOR_PUBKEY":"%s","DRY_RUN":"true","RPC_URL":"https://rpc.invalid/?api-key=x"}\n' "$CREATOR" >"$W/fake/vars-worker.json"
  echo '{"DRY_RUN":"true"}' >"$W/fake/vars-api.json"
  echo dry_run >"$W/fake/mode"
}
# run "<stdin>": launch.sh with the fakes; every output line gets the milliseconds since the start
run() {
  local t0
  t0=$(now_ms)
  echo "$t0" >"$W/fake/t0"
  printf '%s' "$1" | env -i PATH="$W/bin:/usr/bin:/bin" HOME="$W/home" FAKE_DIR="$W/fake" CREATOR_FAKE="$CREATOR" WSR_RAILWAY=railway WSR_RAT=fake-rat \
    WSR_POLL_SEC=0 WSR_RETRY_SEC=0 LAT_MS="${LAT_MS:-0}" SSH_MS="${SSH_MS:-0}" bash "$REPO/scripts/launch.sh" >"$W/out.raw" 2>&1
  local rc=$?
  cp "$W/out.raw" "$W/out.txt"
  return $rc
}
calls() { grep -c " $1" "$W/fake/calls.log" 2>/dev/null || echo 0; }

echo "== timings: Railway as slow as during its incidents (2 s per API call, 8 s per railway ssh, a 5 minute build)"
# scaled 1:20 so the rehearsal takes seconds: 100 ms per API call, 400 ms per ssh, 30 polls of the 10 s wait
reset
echo 30 >"$W/fake/polls"
LAT_MS=100 SSH_MS=400 run $'\ny\nGO\n'; rc=$?
check "LIVE" '[ $rc = 0 ] && grep -q "LIVE.*the bot runs" "$W/out.txt"'
api=$(calls "railway"); ssh=$(calls "ssh"); polls=$(grep -c "railway service status" "$W/fake/calls.log")
# at real speed: 2 s per API call except the status polls (every 10 s while building), 8 s per ssh, 5 min build
est=$(( (api - polls) * 2 + ssh * 8 + 300 ))
check "one build, and under 10 minutes from GO to LIVE at incident speed (estimated $((est / 60)) min $((est % 60)) s: $((api - polls)) Railway calls, $ssh ssh calls, one build)" '[ "$(grep -c "railway redeploy" "$W/fake/calls.log")" = 2 ] && [ $est -lt 600 ]'
[ "${TIMINGS:-}" = 1 ] && awk -v t0="$(cat "$W/fake/t0")" '{ printf "  +%6.1fs  %s %s %s\n", ($1 - t0) / 1000, $2, $3, $4 }' "$W/fake/calls.log"

echo "== Railway's API failing (the incident): every read answers after two failures"
reset
echo 2 >"$W/fake/fail_list"
run $'\ny\nGO\n'; rc=$?
check "the first variable read fails twice, then answers: the launch goes on to LIVE" '[ $rc = 0 ] && grep -q "LIVE.*the bot runs" "$W/out.txt"'

echo "== a lost write: Railway answers OK to the launch settings but keeps no DRY_RUN=false"
reset
echo DRY_RUN >"$W/fake/drop_key"
run $'\ny\nGO\n'; rc=$?
check "stops before any redeploy, says what to do (run it again)" '[ $rc = 1 ] && ! grep -q "railway redeploy" "$W/fake/calls.log" && grep -q "Run scripts/launch.sh again" "$W/out.txt"'
rm -f "$W/fake/drop_key"
: >"$W/fake/calls.log"
run $'y\nGO\n'; rc=$?
check "the second run finishes it: the settings already there are completed, one redeploy, LIVE" '[ $rc = 0 ] && grep -q "LIVE.*the bot runs" "$W/out.txt" && [ "$(grep -c "railway redeploy" "$W/fake/calls.log")" = 2 ] && [ "$(jq -r .DRY_RUN "$W/fake/vars-worker.json")" = false ]'
check "the second run never asks for the launch again (it keeps the coin from the first)" 'grep -q "MintLaunch" "$W/out.txt" && ! grep -q "Now launch the coin" "$W/out.txt"'

echo "== the API build fails"
reset
echo FAILED >"$W/fake/build_api"
run $'\ny\nGO\n'; rc=$?
check "stops with what to do: the settings are LIVE, run it again once the build problem is fixed" '[ $rc = 1 ] && grep -q "api did not start (status FAILED)" "$W/out.txt" && grep -q "scripts/launch.sh again" "$W/out.txt"'
rm -f "$W/fake/build_api"
: >"$W/fake/calls.log"
run $'y\n'; rc=$?
check "the second run sees the worker LIVE and only redeploys the API (asked first)" '[ $rc = 0 ] && grep -q "already runs LIVE" "$W/out.txt" && grep -q "the API runs with the live settings" "$W/out.txt" && [ "$(grep -c "railway redeploy --service api" "$W/fake/calls.log")" = 1 ] && ! grep -q "railway redeploy --service worker" "$W/fake/calls.log"'

echo "== railway ssh after the redeploy: the old container still answers, then ssh drops once"
reset
echo 2 >"$W/fake/stale_status"
run $'\ny\nGO\n'; rc=$?
check "not called 'not LIVE' while the old DRY RUN container drains: it asks again until the new one answers" '[ $rc = 0 ] && grep -q "LIVE.*the bot runs" "$W/out.txt"'
reset
cat >"$W/bin/fake-rat-wrap" <<'EOF'
#!/bin/bash
# the status call after the redeploy fails 3 times (railway ssh drops), then answers
if [ "$1" = status ] && [ "$(cat "$FAKE_DIR/mode")" = live ]; then
  n=$(cat "$FAKE_DIR/ssh_after" 2>/dev/null || echo 3)
  if [ "$n" -gt 0 ]; then echo $((n - 1)) >"$FAKE_DIR/ssh_after"; echo "railway ssh: connection closed" >&2; exit 1; fi
fi
exec fake-rat "$@"
EOF
chmod +x "$W/bin/fake-rat-wrap"
printf '%s' $'\ny\nGO\n' | env -i PATH="$W/bin:/usr/bin:/bin" HOME="$W/home" FAKE_DIR="$W/fake" CREATOR_FAKE="$CREATOR" WSR_RAILWAY=railway WSR_RAT=fake-rat-wrap \
  WSR_POLL_SEC=0 WSR_RETRY_SEC=0 bash "$REPO/scripts/launch.sh" >"$W/out.txt" 2>&1
rc=$?
check "ssh dropping 3 times after the redeploy: asked again, LIVE (never a false 'not LIVE')" '[ $rc = 0 ] && grep -q "LIVE.*the bot runs" "$W/out.txt"'

echo "== railway ssh down for the live preflight: a clear stop, never a silent exit"
reset
printf '#!/bin/bash\n[ "$1" = --with ] && { echo "railway ssh: connection closed" >&2; exit 1; }\nexec fake-rat "$@"\n' >"$W/bin/fake-rat-nopre"
chmod +x "$W/bin/fake-rat-nopre"
printf '%s' $'\ny\nGO\n' | env -i PATH="$W/bin:/usr/bin:/bin" HOME="$W/home" FAKE_DIR="$W/fake" CREATOR_FAKE="$CREATOR" WSR_RAILWAY=railway WSR_RAT=fake-rat-nopre \
  WSR_POLL_SEC=0 WSR_RETRY_SEC=0 bash "$REPO/scripts/launch.sh" >"$W/out.txt" 2>&1
rc=$?
check "stops with the reason (the preflight gave no answer) before anything changed" '[ $rc = 1 ] && grep -q "preflight gave no answer" "$W/out.txt" && ! grep -q "railway redeploy" "$W/fake/calls.log" && [ "$(jq -r .DRY_RUN "$W/fake/vars-worker.json")" = true ]'

echo "launch-rehearsal: $FAILS failed"
[ "$FAILS" = 0 ]
