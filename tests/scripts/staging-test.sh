#!/bin/bash
# scripts/staging.sh control flow with fake `rat` and `railway` (no network, no chain): the isolation checks, the GO
# gate (nothing is sent without the exact word GO), the kill switch always back ON after a phase (also when the phase
# fails), and the GO / NO-GO report. Run: bash tests/scripts/staging-test.sh
# shellcheck disable=SC2016,SC2034 # each check is a string evaluated later (check), rc is read there
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
FAILS=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; FAILS=$((FAILS + 1)); fi; }

mkdir -p "$W/home/rat-secrets-staging" "$W/home/rat-secrets" "$W/bin" "$W/fake"
TEST_CREATOR=CCtCZryKG3cdEFUAYPd5S1kFVhJ3mpEy2ciDqu59CvWT
printf 'PROFILE=staging\nRAILWAY_PROJECT_ID=proj-staging\nAPI_DOMAIN=api.invalid\n' >"$W/home/rat-secrets-staging/setup-state.env"
printf 'RAILWAY_PROJECT_ID=proj-production\n' >"$W/home/rat-secrets/setup-state.env"
printf 'production-master-key\n' >"$W/home/rat-secrets/KEY_ENCRYPTION_KEY.txt"

# fake railway: the linked project and the worker's variables come from files the test changes. fail_reads: that many
# `variable list` calls fail like Railway's did during an incident; drop_sets: `variable set` answers OK, keeps nothing
cat >"$W/bin/railway" <<'EOF'
#!/bin/bash
F="$FAKE_DIR"
case "$1 $2" in
  "status --json") cat "$F/linked" ;;
  "variable list")
    n=$(cat "$F/fail_reads" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo $((n - 1)) >"$F/fail_reads"; echo "Failed to fetch: error decoding response body" >&2; exit 1; fi
    cat "$F/worker.json" ;;
  "variable set")
    echo "railway $*" >>"$F/railway.log"
    echo "set" >>"$F/order.log"
    [ -f "$F/drop_sets" ] && exit 0
    shift 2
    for a in "$@"; do
      case "$a" in --*) break ;; *=*) jq -c --arg k "${a%%=*}" --arg v "${a#*=}" '.[$k] = $v' "$F/worker.json" >"$F/w.tmp" && mv "$F/w.tmp" "$F/worker.json" ;; esac
    done ;;
  "redeploy --service") # a new deployment of that service; state-<service> (default SUCCESS) is how it ends
    echo "redeploy $3" >>"$F/order.log"
    echo $(($(cat "$F/dep-$3" 2>/dev/null || echo 0) + 1)) >"$F/dep-$3" ;;
  "service status")
    echo "status $4" >>"$F/order.log"
    printf '{"status":"%s","deploymentId":"d%s"}\n' "$(cat "$F/state-$4" 2>/dev/null || echo SUCCESS)" "$(cat "$F/dep-$4" 2>/dev/null || echo 0)" ;;
  *) echo "railway $*" >>"$F/railway.log" ;;
esac
EOF
# fake rat: a kill switch, claims that appear once the switch is off, an audit whose answer the test sets
cat >"$W/bin/fake-rat" <<'EOF'
#!/bin/bash
F="$FAKE_DIR"
kill=$(cat "$F/kill")
case "$1" in
  status)
    # trip: the bot saw a creator transaction it did not send and turned the kill switch on by itself
    if [ "$kill" = off ] && [ -f "$F/trip" ]; then echo on >"$F/kill"; kill=on; fi
    if [ "$kill" = off ]; then echo 1 >"$F/claims"; fi
    printf '{"mode":"live","staging":true,"killSwitch":{"on":%s,"reason":"test"},"claims":%s,"openReservations":0,"claimedSol":"0.0009"}\n' \
      "$([ "$kill" = on ] && echo true || echo false)" "$(cat "$F/claims")" ;;
  kill) echo on >"$F/kill"; echo "kill $*" >>"$F/rat.log" ;;
  resume) echo off >"$F/kill"; echo "resume" >>"$F/rat.log" ;;
  audit) cat "$F/audit" ;;
  --with) # the read-only launch preflight with the coin's settings (scripts/lib/launch.sh)
    w=""; while [ "${1:-}" = --with ]; do w="$w $2"; shift 2; done
    echo "preflight-with$w" >>"$F/order.log"; cat "$F/pre-with" ;;
  preflight) cat "$F/pre-live" ;;
  dry-run-reset) echo "dry-run-reset" >>"$F/order.log" ;;
  *) echo "rat $*" >>"$F/rat.log" ;;
esac
EOF
# fake Solana RPC behind curl (scripts/lib/wsr.sh rpc): the launch is the one signature after "sigBefore"
cat >"$W/bin/curl" <<'EOF'
#!/bin/bash
d=""; prev=""; for a in "$@"; do [ "$prev" = -d ] && d="$a"; prev="$a"; done
cat >/dev/null
case "$d" in
  *getBalance*) echo '{"result":{"value":470000000}}' ;;
  *getSignaturesForAddress*'"limit":1}'*) echo '{"result":[{"signature":"sigBefore","slot":900,"err":null}]}' ;;
  *getSignaturesForAddress*) echo '{"result":[{"signature":"sigLaunch","slot":1000,"err":null},{"signature":"sigBefore","slot":900,"err":null}]}' ;;
  *getTransaction*) printf '{"result":{"meta":{"postTokenBalances":[{"owner":"%s","mint":"MintTest","uiTokenAmount":{"amount":"1"}}]}}}\n' "$TEST_CREATOR_FAKE" ;;
  *) exit 7 ;;
esac
EOF
chmod +x "$W/bin/"*
reset() {
  echo '{"id":"proj-staging","name":"wall-street-rats-staging"}' >"$W/fake/linked"
  printf '{"CREATOR_PUBKEY":"%s","STAGING":"true","KEY_ENCRYPTION_KEY":"staging-master-key"}\n' "$TEST_CREATOR" >"$W/fake/worker.json"
  echo on >"$W/fake/kill"
  echo 0 >"$W/fake/claims"
  echo '{"lines":[{"status":"PASS","check":"claims","detail":"ok"},{"status":"PASS","check":"rats","detail":"ok"},{"status":"PASS","check":"money","detail":"ok"}]}' >"$W/fake/audit"
  : >"$W/fake/rat.log"
  echo '{"lines":[{"status":"PASS","check":"launch txs","detail":"ok"},{"status":"PASS","check":"dev buy","detail":"ok"},{"status":"FAIL","check":"kill switch","detail":"on"}]}' >"$W/fake/pre-with"
  cp "$W/fake/pre-with" "$W/fake/pre-live"
  rm -f "$W/fake/fail_reads" "$W/fake/drop_sets" "$W/fake/trip" "$W/fake/order.log" "$W/fake/railway.log" "$W/fake/"dep-* "$W/fake/"state-*
  rm -f "$W/home/rat-secrets-staging/rehearsal-results.env"
}
run() { # run "<stdin>" args...: scripts/staging.sh with the fakes
  local input="$1"
  shift
  printf '%s' "$input" | env -i PATH="$W/bin:/usr/bin:/bin" HOME="$W/home" FAKE_DIR="$W/fake" WSR_RAILWAY=railway WSR_RAT=fake-rat WSR_POLL_SEC=0 WSR_RETRY_SEC=0 TEST_CREATOR_FAKE="$TEST_CREATOR" \
    bash "$REPO/scripts/staging.sh" "$@" >"$W/out.txt" 2>&1
}
results() { cat "$W/home/rat-secrets-staging/rehearsal-results.env" 2>/dev/null; }

echo "== isolation"
reset
run "" check; rc=$?
check "the staging project passes" '[ $rc = 0 ] && results | grep -q "^PHASE_0=PASS"'
echo '{"id":"proj-production","name":"wall-street-rats"}' >"$W/fake/linked"
run "" check; rc=$?
check "linked to production: refused" '[ $rc = 1 ] && grep -q "PRODUCTION project" "$W/out.txt"'
reset
printf '{"CREATOR_PUBKEY":"4VYWcTTDYyMVic58AcUC7Nodt6vNQwjKhA9UphaAKiot","STAGING":"true","KEY_ENCRYPTION_KEY":"x"}\n' >"$W/fake/worker.json"
run "" check; rc=$?
check "the production creator: refused" '[ $rc = 1 ] && grep -q "must be the test creator" "$W/out.txt"'
reset
printf '{"CREATOR_PUBKEY":"%s","STAGING":"true","KEY_ENCRYPTION_KEY":"production-master-key"}\n' "$TEST_CREATOR" >"$W/fake/worker.json"
run "" check; rc=$?
check "the production master key: refused" '[ $rc = 1 ] && grep -q "PRODUCTION master key" "$W/out.txt"'
reset
printf '{"CREATOR_PUBKEY":"%s","KEY_ENCRYPTION_KEY":"x"}\n' "$TEST_CREATOR" >"$W/fake/worker.json"
run "" 2; rc=$?
check "a phase without STAGING on the worker: refused before anything" '[ $rc = 1 ] && grep -q "STAGING is not true" "$W/out.txt" && [ ! -s "$W/fake/rat.log" ]'

echo "== Railway's API failing (an incident)"
reset
echo 2 >"$W/fake/fail_reads"
run "" check; rc=$?
check "two failed reads, then an answer: retried, the checks pass" '[ $rc = 0 ] && results | grep -q "^PHASE_0=PASS"'
reset
printf '{"CREATOR_PUBKEY":"%s","STAGING":"true","KEY_ENCRYPTION_KEY":"production-master-key"}\n' "$TEST_CREATOR" >"$W/fake/worker.json"
echo 99 >"$W/fake/fail_reads"
run "" check; rc=$?
check "the worker's variables never readable: refused (a failed read never counts as a different master key)" '[ $rc = 1 ] && grep -q "its master key could not be compared" "$W/out.txt"'
lib() { # lib 'commands': scripts/lib/wsr.sh with the fakes
  env -i PATH="$W/bin:/usr/bin:/bin" HOME="$W/home" FAKE_DIR="$W/fake" WSR_RAILWAY=railway WSR_RETRY_SEC=0 \
    bash -c "set -euo pipefail; source '$REPO/scripts/lib/wsr.sh'; $1" >"$W/out.txt" 2>&1
}
reset
echo 1 >"$W/fake/fail_reads"
lib 'set_vars worker COIN_MINT=abc WATCH_FROM_SLOT=7'; rc=$?
check "set_vars: written, then read back (a failed read retried)" '[ $rc = 0 ] && [ "$(jq -r .COIN_MINT "$W/fake/worker.json")" = abc ] && [ "$(jq -r .WATCH_FROM_SLOT "$W/fake/worker.json")" = 7 ]'
reset
touch "$W/fake/drop_sets"
lib 'set_vars worker COIN_MINT=abc'; rc=$?
check "set_vars: Railway answers OK but does not keep it: stops" '[ $rc = 1 ] && grep -q "Railway does not show COIN_MINT on worker after setting it" "$W/out.txt"'

echo "== builds side by side (phase 1 builds the worker and the API at once)"
reset
lib 'redeploy worker api'; rc=$?
check "both builds start before any wait, then both run" '[ $rc = 0 ] && [ "$(head -4 "$W/fake/order.log" | tr "\n" " ")" = "status worker redeploy worker status api redeploy api " ] && grep -q "api is running" "$W/out.txt"'
reset
echo FAILED >"$W/fake/state-api"
lib 'redeploy worker api'; rc=$?
check "one of them fails: stops, naming it" '[ $rc = 1 ] && grep -q "api did not start (status FAILED)" "$W/out.txt"'

echo "== phase 6 --skip-watchdog (the kill switch part only)"
reset
run $'GO\n\ny\n' 6 --skip-watchdog; rc=$?
check "without phase 1: refused, nothing sent" '[ $rc = 1 ] && grep -q "run phase 1 first" "$W/out.txt" && ! grep -q resume "$W/fake/rat.log"'
reset
printf 'PHASE_1=PASS|t|live\n' >"$W/home/rat-secrets-staging/rehearsal-results.env"
touch "$W/fake/trip"
run $'GO\n\ny\n' 6 --skip-watchdog; rc=$?
check "the kill switch turned itself on: PARTIAL (never PASS), the worker never stopped" '[ $rc = 0 ] && results | grep -q "^PHASE_6=PARTIAL|.*NOT tested" && [ "$(cat "$W/fake/kill")" = on ] && ! grep -q "railway down" "$W/fake/railway.log" 2>/dev/null'
reset
printf 'PHASE_1=PASS|t|live\n' >"$W/home/rat-secrets-staging/rehearsal-results.env"
run $'GO\n\ny\n' 6 --typo; rc=$?
check "an unknown option: refused before anything" '[ $rc = 1 ] && grep -q "phase 6 takes only --skip-watchdog" "$W/out.txt" && ! grep -q resume "$W/fake/rat.log"'

echo "== phase 1: the launch-day flow (one change, one redeploy)"
reset
printf '{"CREATOR_PUBKEY":"%s","STAGING":"true","KEY_ENCRYPTION_KEY":"staging-master-key","RPC_URL":"https://rpc.invalid/?api-key=x"}\n' "$TEST_CREATOR" >"$W/fake/worker.json"
run $'GO\n\ny\ny\n' 1; rc=$?
check "PASS" '[ $rc = 0 ] && results | grep -q "^PHASE_1=PASS"'
check "the live preflight saw the coin's settings before anything changed" 'grep -q "^preflight-with COIN_MINT=MintTest WATCH_FROM_SLOT=1001 KNOWN_OWNER_TX_SIGS=sigLaunch DRY_RUN=false LIVE_CONFIRM=I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS$" "$W/fake/order.log" && [ "$(grep -n "^preflight-with" "$W/fake/order.log" | cut -d: -f1)" -lt "$(grep -n "^set" "$W/fake/order.log" | head -1 | cut -d: -f1)" ]'
check "one redeploy of the worker and one of the API" '[ "$(grep -c "^redeploy worker" "$W/fake/order.log")" = 1 ] && [ "$(grep -c "^redeploy api" "$W/fake/order.log")" = 1 ]'
check "the kill switch stayed ON" '[ "$(cat "$W/fake/kill")" = on ] && ! grep -q resume "$W/fake/rat.log"'
reset
printf '{"CREATOR_PUBKEY":"%s","STAGING":"true","KEY_ENCRYPTION_KEY":"staging-master-key","RPC_URL":"https://rpc.invalid/?api-key=x"}\n' "$TEST_CREATOR" >"$W/fake/worker.json"
echo '{"lines":[{"status":"FAIL","check":"launch txs","detail":"1 unlisted"},{"status":"PASS","check":"dev buy","detail":"ok"}]}' >"$W/fake/pre-with"
run $'GO\n\ny\ny\n' 1; rc=$?
check "the coin's settings fail the preflight: FAIL before anything changed" '[ $rc = 1 ] && results | grep -q "^PHASE_1=FAIL" && ! grep -q "^set\|^redeploy\|^dry-run-reset" "$W/fake/order.log"'

echo "== the GO gate and the kill switch (phase 2)"
reset
printf 'PHASE_1=PASS|t|launched\n' >"$W/home/rat-secrets-staging/rehearsal-results.env"
run $'\ngo\n' 2; rc=$?
check "anything but GO: nothing sent, the kill switch never opened" '[ $rc = 1 ] && ! grep -q resume "$W/fake/rat.log" && [ "$(cat "$W/fake/kill")" = on ] && results | grep -q "^PHASE_2=SKIP"'
reset
printf 'PHASE_1=PASS|t|launched\n' >"$W/home/rat-secrets-staging/rehearsal-results.env"
run $'\nGO\n' 2; rc=$?
check "GO: the switch opens, the claim lands, the audit passes, PASS" '[ $rc = 0 ] && grep -q resume "$W/fake/rat.log" && results | grep -q "^PHASE_2=PASS"'
check "the kill switch is ON again after the phase" '[ "$(cat "$W/fake/kill")" = on ]'
reset
printf 'PHASE_1=PASS|t|launched\n' >"$W/home/rat-secrets-staging/rehearsal-results.env"
echo '{"lines":[{"status":"FAIL","check":"money","detail":"creator SOL differs from the ledger"}]}' >"$W/fake/audit"
run $'\nGO\n' 2; rc=$?
check "an audit FAIL fails the phase" '[ $rc = 1 ] && results | grep -q "^PHASE_2=FAIL"'
check "and the kill switch is ON again" '[ "$(cat "$W/fake/kill")" = on ]'
reset
echo off >"$W/fake/kill"
printf 'PHASE_1=PASS|t|launched\n' >"$W/home/rat-secrets-staging/rehearsal-results.env"
run $'\nGO\n' 2; rc=$?
check "a kill switch already off: the phase refuses to start" '[ $rc = 1 ] && grep -q "already off" "$W/out.txt" && ! grep -q resume "$W/fake/rat.log"'

echo "== the report"
reset
printf 'PHASE_0=PASS|t|x\nPHASE_1=PASS|t|x\nPHASE_2=PASS|t|x\n' >"$W/home/rat-secrets-staging/rehearsal-results.env"
run "" report
check "phases not run: NO-GO" 'grep -q "^## NO-GO" "$W/out.txt" && grep -q "| 3 | NOT RUN" "$W/out.txt"'
for p in 3 4 5 6 7 8; do printf 'PHASE_%s=PASS|t|x\n' "$p" >>"$W/home/rat-secrets-staging/rehearsal-results.env"; done
run "" report
check "every phase PASS but no production site check: NO-GO" 'grep -q "^## NO-GO" "$W/out.txt"'
printf 'SITE_GO_LIVE=PASS|site ok\n' >>"$W/home/rat-secrets/setup-state.env"
run "" report
check "every phase and the site check PASS: GO" 'grep -q "^## GO$" "$W/out.txt"'
printf 'PHASE_6=PARTIAL|t|watchdog not tested\n' >>"$W/home/rat-secrets-staging/rehearsal-results.env"
run "" report
check "phase 6 PARTIAL (--skip-watchdog): NO-GO" 'grep -q "^## NO-GO" "$W/out.txt" && grep -q "| 6 | PARTIAL" "$W/out.txt"'
printf 'PHASE_6=FAIL|t|no alert\n' >>"$W/home/rat-secrets-staging/rehearsal-results.env"
run "" report
check "any FAIL: NO-GO" 'grep -q "^## NO-GO" "$W/out.txt"'

echo "staging-test: $FAILS failed"
[ "$FAILS" = 0 ]
